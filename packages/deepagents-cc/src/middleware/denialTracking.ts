/**
 * Tool denial tracking middleware.
 *
 * When the user (or a hook, or a permission check) denies a tool call,
 * cc remembers the denial fingerprint and rejects an identical retry on
 * sight. Without this, the model often sees the denial, "thinks again",
 * decides the call is still the right move, and re-proposes it — which
 * just costs another permission round-trip and frustrates the user.
 *
 * Fingerprint = `${toolName}:${stableJson(args)}`. We track the last N
 * denials per session.
 */

import {
  createMiddleware,
  ToolMessage,
  type AgentMiddleware,
} from 'langchain'
import { z } from 'zod/v4'
import { denialFingerprint as fingerprint, stableJson } from './denialFingerprint.js'

export { fingerprint as denialFingerprint, stableJson }

const stateSchema = z.object({
  deniedToolCalls: z
    .array(
      z.object({
        fingerprint: z.string(),
        reason: z.string().optional(),
        deniedAt: z.number(),
      }),
    )
    .default([]),
})

export interface DenialTrackingMiddlewareOptions {
  maxRemembered?: number
  /** A predicate the host can plug in to decide "this looks like a denial". */
  isDenial?: (result: ToolMessage) => boolean
}

export function createDenialTrackingMiddleware(
  options: DenialTrackingMiddlewareOptions = {},
): AgentMiddleware {
  const cap = options.maxRemembered ?? 32
  const isDenial =
    options.isDenial ??
    ((m: ToolMessage) => {
      if (m.status === 'error') return false // tool errors aren't denials
      const text = typeof m.content === 'string' ? m.content : ''
      // Heuristics: PermissionMode middleware emits "Plan mode is active",
      // hooks emit "[blocked by ...] ...", custom hooks may say "denied".
      return /\b(deni(ed|al)|blocked|refused|not permitted)\b/i.test(text)
    })

  return createMiddleware({
    name: 'DenialTrackingMiddleware',
    stateSchema,
    wrapToolCall: async (
      request: {
        toolCall: { name: string; id: string; args: unknown }
        state: {
          deniedToolCalls?: Array<{
            fingerprint: string
            reason?: string
            deniedAt: number
          }>
        }
      },
      handler: (req: typeof request) => Promise<ToolMessage | unknown>,
    ) => {
      const fp = fingerprint(request.toolCall.name, request.toolCall.args)
      const past = request.state.deniedToolCalls ?? []
      const previously = past.find(d => d.fingerprint === fp)
      if (previously) {
        return new ToolMessage({
          content: `This exact call was denied earlier in this session: "${previously.reason ?? 'denied'}". Do not re-propose it — pick a different approach or ask the user.`,
          tool_call_id: request.toolCall.id,
          name: request.toolCall.name,
          status: 'error',
        })
      }
      const result = await handler(request)
      if (result instanceof ToolMessage && isDenial(result)) {
        const text = typeof result.content === 'string' ? result.content : ''
        const updated = [
          ...past,
          { fingerprint: fp, reason: text.slice(0, 200), deniedAt: Date.now() },
        ].slice(-cap)
        // Surface the denial back to the model as-is, but stash the
        // fingerprint so the NEXT identical attempt is short-circuited.
        return Object.assign(result, {
          // langchain does not give us a clean way to merge state from
          // wrapToolCall — we rely on a sibling middleware (or the
          // permission middleware) to write `deniedToolCalls` via Command.
          // We emit a synthetic property so downstream code can pick it up.
          additional_kwargs: {
            ...(result.additional_kwargs ?? {}),
            __denialFingerprint: fp,
            __deniedToolCalls: updated,
          },
        })
      }
      return result
    },
  })
}


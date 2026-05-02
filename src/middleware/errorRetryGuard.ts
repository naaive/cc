/**
 * Error-retry guard.
 *
 * Models often retry the *same* tool call after seeing the same error message
 * ("ENOENT: file.ts" → "let me try again with the same path") rather than
 * diagnosing why. This middleware fingerprints (toolName, args, error-text)
 * and short-circuits the second identical retry within the same session:
 * instead of running the tool again, we synthesize a tool result that says
 * "you just tried this and got the same error — diagnose, don't retry
 * blindly".
 *
 * Plus: a halt-on-N-consecutive-errors circuit breaker. After N back-to-back
 * errors (regardless of tool), inject a system-reminder telling the model to
 * stop and ask the user.
 */

import {
  createMiddleware,
  ToolMessage,
  type AgentMiddleware,
} from 'langchain'
import { z } from 'zod'
import { denialFingerprint } from '../lib/fingerprint.js'

export interface ErrorRetryGuardOptions {
  /** Cap on the number of recent error fingerprints we remember. */
  maxRemembered?: number
  /** Halt threshold: after N consecutive errors, surface a stop signal. */
  haltAfterConsecutive?: number
  /** Optional callback when the guard fires (telemetry / UI). */
  onCaughtRetry?: (toolName: string, fingerprint: string) => void
  onHalt?: (consecutive: number) => void
}

const stateSchema = z.object({
  toolErrors: z
    .array(
      z.object({
        fingerprint: z.string(),
        errorText: z.string(),
        at: z.number(),
      }),
    )
    .default([]),
  consecutiveErrors: z.number().int().nonnegative().default(0),
})

const HALT_REMINDER =
  'You have hit the consecutive-error threshold. Stop trying to retry blindly — diagnose the root cause, or use AskUserQuestion to surface the blocker.'

export function createErrorRetryGuardMiddleware(
  options: ErrorRetryGuardOptions = {},
): AgentMiddleware {
  const cap = options.maxRemembered ?? 32
  const haltAfter = options.haltAfterConsecutive ?? 4

  return createMiddleware({
    name: 'ErrorRetryGuardMiddleware',
    stateSchema,
    wrapToolCall: async (request, handler) => {
      const fp = denialFingerprint(request.toolCall.name, request.toolCall.args)
      const past = request.state.toolErrors ?? []
      const previous = past.find(d => d.fingerprint === fp)
      if (previous) {
        options.onCaughtRetry?.(request.toolCall.name, fp)
        return new ToolMessage({
          content: `This exact call previously errored: "${previous.errorText.slice(0, 200)}". Re-running with the same args won't help — read the error, change tactics, or ask the user. (Use slightly different args to bypass this guard.)`,
          tool_call_id: request.toolCall.id ?? '',
          name: request.toolCall.name,
          status: 'error',
        })
      }

      const result = await handler(request)
      if (!(result instanceof ToolMessage)) return result
      if (result.status !== 'error') {
        // Success — reset consecutive counter via additional_kwargs piggy-back.
        ;(result as unknown as { additional_kwargs: Record<string, unknown> }).additional_kwargs = {
          ...(result.additional_kwargs ?? {}),
          __resetConsecutiveErrors: true,
        }
        return result
      }

      const errorText = typeof result.content === 'string' ? result.content : ''
      const updatedErrors = [
        ...past,
        { fingerprint: fp, errorText, at: Date.now() },
      ].slice(-cap)
      const consecutive = (request.state.consecutiveErrors ?? 0) + 1

      if (consecutive >= haltAfter) {
        options.onHalt?.(consecutive)
        return new ToolMessage({
          content: `${errorText}\n\n[error-retry guard: ${consecutive} consecutive tool errors — ${HALT_REMINDER}]`,
          tool_call_id: result.tool_call_id ?? '',
          name: result.name,
          status: 'error',
        })
      }
      ;(result as unknown as { additional_kwargs: Record<string, unknown> }).additional_kwargs = {
        ...(result.additional_kwargs ?? {}),
        __toolErrors: updatedErrors,
        __consecutiveErrors: consecutive,
      }
      return result
    },
  })
}

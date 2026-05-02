/**
 * Permission-mode middleware — gate tool calls by mode + fine-grained rules.
 *
 * Two layers, evaluated in order:
 *   1. Per-tool/per-arg rules (from settings.permissions). First match wins.
 *      An "allow" rule short-circuits the mode gate; a "deny" rule rejects.
 *   2. Mode classifier (read vs write vs unknown). plan mode blocks writes.
 *
 * we evaluate rules first because that's the strongest user signal:
 * a user-defined deny on `Bash command="rm -rf*"` should fire even in
 * `bypassPermissions` mode.
 */

import {
  createMiddleware,
  type AgentMiddleware,
  ToolMessage,
} from 'langchain'
import { z } from 'zod'
import {
  decide,
  PERMISSION_MODES,
  type PermissionMode,
} from '../permissionMode.js'
import {
  evaluateRules,
  type PermissionRule,
} from '../permissionRules.js'

export interface PermissionModeMiddlewareOptions {
  initialMode?: PermissionMode
  /** Tools the host wants to mark read-only beyond the built-ins. */
  extraReadOnly?: string[]
  /** Fine-grained rules. First match wins. Empty array = no rule layer. */
  rules?: readonly PermissionRule[]
  /** Optional per-call hook so a UI can prompt the user before destructive ops. */
  onDenied?: (toolName: string, reason: string) => void
}

const stateSchema = z.object({
  permissionMode: z.enum(PERMISSION_MODES).default('default'),
  pendingPlan: z.string().optional(),
})

export function createPermissionModeMiddleware(
  options: PermissionModeMiddlewareOptions = {},
): AgentMiddleware {
  const extra = new Set(options.extraReadOnly ?? [])
  const rules = options.rules ?? []
  const initial = options.initialMode ?? 'default'

  return createMiddleware({
    name: 'PermissionModeMiddleware',
    stateSchema,
    beforeAgent: (state: { permissionMode?: PermissionMode }) => {
      if (state.permissionMode == null) return { permissionMode: initial }
      return undefined
    },
    wrapToolCall: async (request, handler) => {
      // Layer 1: per-tool rules.
      const rule = evaluateRules(request.toolCall.name, request.toolCall.args, rules)
      if (rule.mode === 'deny') {
        const reason = rule.reason ?? 'Denied by permission rule.'
        options.onDenied?.(request.toolCall.name, reason)
        return new ToolMessage({
          content: reason,
          tool_call_id: request.toolCall.id ?? '',
          name: request.toolCall.name,
          status: 'error',
        })
      }
      if (rule.mode === 'allow') {
        return handler(request)
      }

      // Layer 2: mode classifier.
      const mode = request.state.permissionMode ?? initial
      const decision = decide(mode, request.toolCall.name, extra)
      if (!decision.allowed) {
        options.onDenied?.(request.toolCall.name, decision.reason ?? 'denied')
        return new ToolMessage({
          content: decision.reason ?? 'Tool denied by permission mode.',
          tool_call_id: request.toolCall.id ?? '',
          name: request.toolCall.name,
          status: 'error',
        })
      }
      return handler(request)
    },
  })
}

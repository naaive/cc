/**
 * Permission middleware — defers every "may this tool run?" question to
 * the unified PermissionGate. This file is a thin adapter that pulls the
 * mode out of state, hands the decision off, and translates the result
 * into a `ToolMessage` rejection when needed.
 */

import {
  createMiddleware,
  type AgentMiddleware,
  ToolMessage,
} from 'langchain'
import { z } from 'zod'
import {
  evaluatePermission,
  PERMISSION_MODES,
  type PermissionMode,
  type PermissionRule,
} from '../permission.js'

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
  const extraReadOnly = new Set(options.extraReadOnly ?? [])
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
      const decision = evaluatePermission({
        mode: request.state.permissionMode ?? initial,
        toolName: request.toolCall.name,
        args: request.toolCall.args,
        rules,
        extraReadOnly,
      })
      if (decision.allowed) return handler(request)
      const reason = decision.reason ?? 'denied'
      options.onDenied?.(request.toolCall.name, reason)
      return new ToolMessage({
        content: reason,
        tool_call_id: request.toolCall.id ?? '',
        name: request.toolCall.name,
        status: 'error',
      })
    },
  })
}

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
  createPermissionContext,
  PERMISSION_MODES,
  type PermissionContext,
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
  /**
   * Receive a read-side `PermissionContext` once the middleware is built.
   * Tools and reminders that want to query "would X be allowed?" outside
   * the wrapToolCall path call through this context.
   */
  onContext?: (context: PermissionContext) => void
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

  // Live mode pointer the read-side context closes over; the middleware
  // updates it before each wrapToolCall, so any tool/reminder holding the
  // returned context sees the current mode without re-importing.
  let liveMode: PermissionMode = initial

  const context: PermissionContext = createPermissionContext({
    getMode: () => liveMode,
    getRules: () => rules,
    extraReadOnly,
  })
  options.onContext?.(context)

  return createMiddleware({
    name: 'PermissionModeMiddleware',
    stateSchema,
    beforeAgent: (state: { permissionMode?: PermissionMode }) => {
      if (state.permissionMode == null) return { permissionMode: initial }
      liveMode = state.permissionMode
      return undefined
    },
    wrapToolCall: async (request, handler) => {
      liveMode = request.state.permissionMode ?? initial
      const decision = context.check(request.toolCall.name, request.toolCall.args)
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

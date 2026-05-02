/**
 * Permission-mode middleware — gate write tools by mode.
 *
 * Sits in the deepagents middleware chain just before subagents/fs. When
 * the agent calls a write tool while in plan mode, we synthesize a tool
 * result that explains the denial and skip the actual call. The agent
 * sees the deny string in its conversation and adapts.
 */

import {
  createMiddleware,
  type AgentMiddleware,
  ToolMessage,
} from 'langchain'
import { z } from 'zod/v4'
import {
  decide,
  PERMISSION_MODES,
  type PermissionMode,
} from '../permissionMode.js'

export interface PermissionModeMiddlewareOptions {
  /** Initial mode. Defaults to "default". */
  initialMode?: PermissionMode
  /** Tools the host wants to mark read-only beyond the built-ins. */
  extraReadOnly?: string[]
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
  const initial = options.initialMode ?? 'default'

  return createMiddleware({
    name: 'PermissionModeMiddleware',
    stateSchema,
    // Set the initial mode if state wasn't seeded.
    beforeAgent: (state: { permissionMode?: PermissionMode }) => {
      if (state.permissionMode == null) return { permissionMode: initial }
      return undefined
    },
    // Wrap every tool call to gate writes in plan mode.
    wrapToolCall: async (
      request: {
        toolCall: { name: string; id: string; args: unknown }
        state: { permissionMode?: PermissionMode }
      },
      handler: (req: typeof request) => Promise<ToolMessage | unknown>,
    ) => {
      const mode = request.state.permissionMode ?? initial
      const decision = decide(mode, request.toolCall.name, extra)
      if (!decision.allowed) {
        options.onDenied?.(request.toolCall.name, decision.reason ?? 'denied')
        return new ToolMessage({
          content: decision.reason ?? 'Tool denied by permission mode.',
          tool_call_id: request.toolCall.id,
          name: request.toolCall.name,
          status: 'error',
        })
      }
      return handler(request)
    },
  })
}

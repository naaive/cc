/**
 * Permission mode — four modes plus a read/write tool classifier.
 *
 * `default` — every tool runs unless an explicit deny rule matches.
 * `acceptEdits` — auto-approve writes; differs from default only in how the
 *   host UI prompts the user.
 * `plan` — read-only; block any tool that mutates state. The model can leave
 *   plan mode by calling ExitPlanMode (after the user approves).
 * `bypassPermissions` — skip every check (only honored when the host process
 *   opts in via env / settings).
 *
 * Read/write classification is sourced from `tools/toolNames.ts` so the tool
 * surface is single-source-of-truth.
 */

import {
  READ_ONLY_TOOL_SET,
  WRITE_TOOL_SET,
  TOOL_NAMES,
} from './tools/toolNames.js'

export const PERMISSION_MODES = [
  'default',
  'acceptEdits',
  'plan',
  'bypassPermissions',
] as const

export type PermissionMode = (typeof PERMISSION_MODES)[number]

export const WRITE_TOOL_NAMES: ReadonlySet<string> = WRITE_TOOL_SET
export const READ_TOOL_NAMES: ReadonlySet<string> = READ_ONLY_TOOL_SET

export interface PermissionDecision {
  allowed: boolean
  reason?: string
}

export function classifyTool(
  name: string,
): 'read' | 'write' | 'unknown' {
  if (WRITE_TOOL_NAMES.has(name)) return 'write'
  if (READ_TOOL_NAMES.has(name)) return 'read'
  return 'unknown'
}

export function decide(
  mode: PermissionMode,
  toolName: string,
  /** Allow plan-mode hosts to whitelist specific custom tools. */
  extraReadOnly?: ReadonlySet<string>,
): PermissionDecision {
  if (mode === 'bypassPermissions') return { allowed: true }

  const klass = classifyTool(toolName)
  const isReadOnly = klass === 'read' || (extraReadOnly?.has(toolName) ?? false)

  if (mode === 'plan') {
    if (isReadOnly) return { allowed: true }
    return {
      allowed: false,
      reason: `Plan mode is active. ${toolName} mutates state and is blocked. Call ${TOOL_NAMES.ExitPlanMode} once the user has approved the plan.`,
    }
  }

  // default / acceptEdits never block here — the host UI may still prompt.
  return { allowed: true }
}

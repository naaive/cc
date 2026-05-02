/**
 * Permission mode — the four cc modes plus the read/write classifier.
 *
 * `default` — every tool runs unless an explicit deny rule matches.
 * `acceptEdits` — auto-approve writes; still gate destructive ops.
 * `plan` — read-only; block any tool that mutates state.
 * `bypassPermissions` — skip every check (dangerous; only honored
 *   when the host process opts in via env / settings).
 */

export const PERMISSION_MODES = [
  'default',
  'acceptEdits',
  'plan',
  'bypassPermissions',
] as const

export type PermissionMode = (typeof PERMISSION_MODES)[number]

/**
 * Tool names known to mutate state. Anything not in this set is treated
 * as read-only by the plan-mode gate. User-defined tools default to
 * "unknown" and the middleware errs on the side of caution: if the tool
 * is unrecognized in plan mode, deny it.
 */
export const WRITE_TOOL_NAMES: ReadonlySet<string> = new Set([
  // deepagents builtins
  'write_file',
  'edit_file',
  // cc additions
  'bash',
  'exit_plan_mode',
])

export const READ_TOOL_NAMES: ReadonlySet<string> = new Set([
  // deepagents builtins
  'read_file',
  'ls',
  'glob',
  'grep',
  // cc additions
  'web_fetch',
  'web_search',
  'enter_plan_mode',
  'ask_user_question',
  // deepagents subagent / planning
  'task',
  'write_todos', // toggling todos is harmless metadata
])

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
      reason: `Plan mode is active. ${toolName} mutates state and is blocked. Call exit_plan_mode once the user has approved the plan.`,
    }
  }

  if (mode === 'acceptEdits') {
    // Same as default for blocking purposes — modes diverge only in how the
    // host UI prompts the user. The middleware never blocks here; an outer
    // hook layer can audit-log if desired.
    return { allowed: true }
  }

  // default
  return { allowed: true }
}

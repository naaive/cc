/**
 * Permission gate — single decision layer for "may this tool call run?".
 *
 * Two layers, evaluated in order:
 *
 *   1. **Per-tool / per-arg rules** (from `settings.permissions` and
 *      caller-supplied additions). First matching rule wins. An `allow`
 *      rule short-circuits the mode gate; a `deny` rule rejects.
 *   2. **Mode classifier**. `bypassPermissions` always allows. `plan`
 *      blocks anything that mutates state (write tools and unknowns).
 *      `default` / `acceptEdits` always allow at this layer — host UIs
 *      may still prompt.
 *
 * Rules are evaluated first because that's the strongest user signal: a
 * user-defined `deny Bash command="rm -rf*"` should fire even in
 * `bypassPermissions` mode.
 *
 * Read/write classification is sourced from `tools/toolNames.ts` so the
 * tool surface stays single-source-of-truth.
 */

import { globToRegex } from './lib/glob.js'
import {
  READ_ONLY_TOOL_SET,
  TOOL_NAMES,
  WRITE_TOOL_SET,
  type ToolName,
} from './tools/toolNames.js'

export const PERMISSION_MODES = [
  'default',
  'acceptEdits',
  'plan',
  'bypassPermissions',
] as const

export type PermissionMode = (typeof PERMISSION_MODES)[number]
export type PermissionRuleMode = 'allow' | 'deny'

export const WRITE_TOOL_NAMES: ReadonlySet<string> = WRITE_TOOL_SET
export const READ_TOOL_NAMES: ReadonlySet<string> = READ_ONLY_TOOL_SET

export interface PermissionRule {
  /** Tool name (PascalCase) or "*" for any. */
  tool: ToolName | '*'
  /**
   * Argument-pattern match. Each field is matched independently against
   * the corresponding argument value. Glob syntax (`*`, `**`, `?`, `[abc]`).
   * String values get glob match; arrays get any-match; numbers/booleans
   * get equality.
   */
  match?: Record<string, string | number | boolean | readonly string[]>
  mode: PermissionRuleMode
  /** Optional human-readable explanation surfaced when the rule fires. */
  reason?: string
}

export interface PermissionDecision {
  allowed: boolean
  /** Reason text, populated when a rule denies or the mode gate denies. */
  reason?: string
  /** Set when a rule (allow or deny) matched. */
  matchedRule?: PermissionRule
}

export interface EvaluatePermissionInput {
  mode: PermissionMode
  toolName: string
  args: unknown
  /** Empty / undefined = no rule layer; mode classifier alone decides. */
  rules?: readonly PermissionRule[]
  /** Tools the host wants to mark read-only beyond the built-ins. */
  extraReadOnly?: ReadonlySet<string>
}

export function evaluatePermission(
  input: EvaluatePermissionInput,
): PermissionDecision {
  const rule = matchFirstRule(input.toolName, input.args, input.rules)
  if (rule) {
    if (rule.mode === 'deny') {
      return {
        allowed: false,
        reason: rule.reason ?? 'Denied by permission rule.',
        matchedRule: rule,
      }
    }
    // `allow` short-circuits the mode gate.
    return { allowed: true, matchedRule: rule }
  }

  if (input.mode === 'bypassPermissions') return { allowed: true }

  const klass = classifyTool(input.toolName)
  const isReadOnly =
    klass === 'read' || (input.extraReadOnly?.has(input.toolName) ?? false)

  if (input.mode === 'plan' && !isReadOnly) {
    return {
      allowed: false,
      reason: `Plan mode is active. ${input.toolName} mutates state and is blocked. Call ${TOOL_NAMES.ExitPlanMode} once the user has approved the plan.`,
    }
  }

  return { allowed: true }
}

export function classifyTool(name: string): 'read' | 'write' | 'unknown' {
  if (WRITE_TOOL_NAMES.has(name)) return 'write'
  if (READ_TOOL_NAMES.has(name)) return 'read'
  return 'unknown'
}

function matchFirstRule(
  toolName: string,
  args: unknown,
  rules: readonly PermissionRule[] | undefined,
): PermissionRule | undefined {
  if (!rules || rules.length === 0) return undefined
  for (const rule of rules) {
    if (rule.tool !== '*' && rule.tool !== toolName) continue
    if (!matchesArgs(rule.match, args)) continue
    return rule
  }
  return undefined
}

function matchesArgs(
  match: PermissionRule['match'] | undefined,
  args: unknown,
): boolean {
  if (!match) return true
  if (args === null || typeof args !== 'object') return false
  const record = args as Record<string, unknown>
  for (const [key, expected] of Object.entries(match)) {
    if (!matchesValue(expected, record[key])) return false
  }
  return true
}

function matchesValue(
  expected: string | number | boolean | readonly string[],
  actual: unknown,
): boolean {
  if (Array.isArray(expected)) {
    if (typeof actual !== 'string') return false
    return expected.some(pattern => matchesString(pattern, actual))
  }
  if (typeof expected === 'string') {
    if (typeof actual !== 'string') return false
    return matchesString(expected, actual)
  }
  return expected === actual
}

function matchesString(pattern: string, value: string): boolean {
  // permission rules treat simple `prefix*` / `*suffix` / literals as
  // substring matches rather than anchored single-segment globs. This is
  // what users expect from rules like `Bash command="git status*"` and
  // `Edit file_path="*.sql"`.
  if (!pattern.includes('?') && !pattern.includes('[') && !pattern.includes('**')) {
    if (pattern.endsWith('*') && !pattern.slice(0, -1).includes('*')) {
      return value.startsWith(pattern.slice(0, -1))
    }
    if (pattern.startsWith('*') && !pattern.slice(1).includes('*')) {
      return value.endsWith(pattern.slice(1))
    }
    if (!pattern.includes('*')) return value === pattern
  }
  return globToRegex(pattern).test(value)
}

/**
 * Fine-grained permission rules.
 *
 * The plan-mode classifier is coarse (read vs. write). cc additionally
 * supports allow/deny rules at the per-tool + per-argument level — e.g.
 * "allow Bash if command starts with `git status`" or "deny Edit on
 * paths under /etc". These rules sit in `settings.permissions` and are
 * evaluated alongside the plan-mode gate.
 *
 * Rule shape:
 *   {
 *     tool: "Bash" | ToolName,
 *     match: { command?: "git status*", file_path?: "/etc/**", ... },
 *     mode: "allow" | "deny"
 *   }
 *
 * Match patterns are simple globs: `*`, `**`, `?`, `[abc]`. Multiple
 * fields are AND-ed. The first matching rule wins. Rules without `match`
 * apply to every call of the named tool.
 */

import { globToRegex } from './tools/globRegex.js'
import type { ToolName } from './tools/ccToolNames.js'

export type PermissionRuleMode = 'allow' | 'deny'

export interface PermissionRule {
  /** Tool name (cc PascalCase) or "*" for any. */
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

export interface RuleDecision {
  /** undefined means "no rule matched"; the caller falls back to default. */
  mode?: PermissionRuleMode
  reason?: string
  matchedRule?: PermissionRule
}

export function evaluateRules(
  toolName: string,
  args: unknown,
  rules: readonly PermissionRule[] | undefined,
): RuleDecision {
  if (!rules || rules.length === 0) return {}
  for (const rule of rules) {
    if (rule.tool !== '*' && rule.tool !== toolName) continue
    if (!matchesArgs(rule.match, args)) continue
    return {
      mode: rule.mode,
      reason: rule.reason,
      matchedRule: rule,
    }
  }
  return {}
}

function matchesArgs(
  match: PermissionRule['match'] | undefined,
  args: unknown,
): boolean {
  if (!match) return true
  if (args === null || typeof args !== 'object') return false
  const record = args as Record<string, unknown>
  for (const [key, expected] of Object.entries(match)) {
    const actual = record[key]
    if (!matchesValue(expected, actual)) return false
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
  // cc-style permission rules treat simple `prefix*` / `*suffix` / literals
  // as substring matches rather than anchored single-segment globs. This
  // is what users expect from rules like `Bash command="git status*"` and
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

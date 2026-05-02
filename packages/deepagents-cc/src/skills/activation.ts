/**
 * Conditional skill activation by file path.
 *
 * cc lets a skill declare `activate-paths: src/auth/**, **\/*.sql` in its
 * frontmatter. When the agent's Read tool touches a matching path, the
 * skill body is queued for injection as a `<system-reminder>` on the
 * next user turn — same mechanism as todo state.
 *
 * The activator is a small stateful helper:
 *   - `notice(absPath)` is called from Read whenever a file is read.
 *   - It returns the set of skill names that match.
 *   - `consume()` returns names that haven't been activated yet this
 *     session (so we don't keep re-injecting the same skill body).
 *   - The host wires the consumed names into a Reminder factory.
 */

import { globToRegex } from '../tools/globRegex.js'
import type { SkillMetadata } from './loader.js'

export interface SkillActivator {
  /** Side-effect: queue any skills whose activate-paths match `absPath`. */
  notice(absPath: string): void
  /** Names noticed but not yet drained. Caller should drain on each turn. */
  pending(): string[]
  drain(): string[]
  /** Pre-activate by name (e.g. from /skill <name>). */
  activate(name: string): void
}

export function createSkillActivator(skills: SkillMetadata[]): SkillActivator {
  // Pre-compile each skill's patterns once. Patterns that don't start
  // with `/` get an implicit `**/` prefix so they match anywhere — cc
  // activate-paths are written as project-relative globs, but we get
  // absolute paths from Read.
  const compiled = skills
    .filter(s => s.activatePaths && s.activatePaths.length > 0)
    .map(s => ({
      name: s.name,
      regexes: s.activatePaths!.map(p =>
        p.startsWith('/') ? globToRegex(p) : globToRegex(`**/${p}`),
      ),
    }))
  // Pending = noticed but not yet drained for injection.
  const pendingSet = new Set<string>()
  // Already-fired so we don't re-inject the same skill twice in a session.
  const fired = new Set<string>()

  return {
    notice(absPath) {
      for (const c of compiled) {
        if (fired.has(c.name)) continue
        if (c.regexes.some(r => r.test(absPath))) {
          pendingSet.add(c.name)
        }
      }
    },
    pending() {
      return [...pendingSet]
    },
    drain() {
      const out = [...pendingSet]
      pendingSet.clear()
      for (const n of out) fired.add(n)
      return out
    },
    activate(name) {
      pendingSet.add(name)
    },
  }
}

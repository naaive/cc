/**
 * Pure reminder factories — kept in their own file so they can be tested
 * without dragging in `langchain` (which the contextEngineering middleware
 * imports for `createMiddleware`).
 *
 * Each factory returns a `Reminder` whose `shouldFire(ctx)` decides on each
 * turn whether to inject a `<system-reminder>` block. Stateful reminders
 * (like the todo-stale nudge) read/write `ctx.state` so throttle windows
 * survive across turns.
 */

import type { Todo } from '../tools/todoWrite.js'
import type { PermissionMode } from '../permissionMode.js'
import type { SkillActivator } from '../skills/activation.js'
import { readSkillBody, type SkillMetadata } from '../skills/loader.js'
import type { FileStateCache } from '../tools/fsUtils.js'
import type { MonitorRegistry } from '../tools/monitor.js'
import {
  analyzeContextBloat,
  type AnalyzeBloatOptions,
  type BloatMessage,
} from '../lib/contextBloat.js'

export interface ReminderContext {
  state: Record<string, unknown>
  turn: number
  lastUserText: string
  todos: Todo[]
  permissionMode: PermissionMode
}

export interface Reminder {
  name: string
  shouldFire(ctx: ReminderContext): string | null | undefined
}

/**
 * reminders. Each is a factory so closures can hold their own
 * "last fired at" cache without leaking across middleware instances.
 */
export const ccReminders = {
  /**
   * Re-inject the full todo list every turn (canonical, by design). The model treats
   * each turn's reminder as the canonical state — it never accumulates the
   * way a tool_result history would.
   */
  todoState(): Reminder {
    return {
      name: 'todo-state',
      shouldFire(ctx) {
        if (ctx.todos.length === 0) return null
        const lines = ctx.todos.map((t, i) => {
          const mark =
            t.status === 'completed'
              ? '[x]'
              : t.status === 'in_progress'
                ? '[~]'
                : '[ ]'
          const label = t.status === 'in_progress' ? t.activeForm : t.content
          return `${i + 1}. ${mark} ${label}`
        })
        return `Current todo list:\n${lines.join('\n')}\n\n(Pass the full list to TodoWrite to update.)`
      },
    }
  },

  /**
   * Nudge to use TodoWrite when there's no todo list and the model has
   * been working for a while. Fires at most once every N turns.
   */
  todoStaleNudge(everyNTurns = 6): Reminder {
    return {
      name: 'todo-stale-nudge',
      shouldFire(ctx) {
        if (ctx.todos.length > 0) return null
        const last =
          (ctx.state['todo-nudge.lastTurn'] as number | undefined) ?? -Infinity
        if (ctx.turn - last < everyNTurns) return null
        ctx.state['todo-nudge.lastTurn'] = ctx.turn
        return "The TodoWrite tool hasn't been used recently. If you're working on tasks that would benefit from tracking progress, consider using TodoWrite. Only use it if it's relevant — ignore otherwise. NEVER mention this reminder to the user."
      },
    }
  },

  /**
   * Persistent warning while plan mode is active. we fire this every turn
   * because plan mode is "sticky" — the model needs the reminder to NOT
   * forget it can only read.
   */
  planModeActive(): Reminder {
    return {
      name: 'plan-mode-active',
      shouldFire(ctx) {
        return ctx.permissionMode === 'plan'
          ? "Plan mode is active. You may use read-only tools (Read/Glob/Grep/WebFetch/WebSearch/AskUserQuestion). Bash, Write, Edit, NotebookEdit are blocked. Submit your plan via ExitPlanMode once it's ready."
          : null
      },
    }
  },

  /**
   * Custom one-off reminder. Useful for hosts that want to inject extra
   * guidance (e.g. "you are running in CI; do NOT push to main").
   */
  custom(name: string, text: string, everyNTurns = 1): Reminder {
    return {
      name,
      shouldFire(ctx) {
        const key = `custom.${name}.lastTurn`
        const last = (ctx.state[key] as number | undefined) ?? -Infinity
        if (ctx.turn - last < everyNTurns) return null
        ctx.state[key] = ctx.turn
        return text
      },
    }
  },

  /**
   * Conditional skill activation. Drains the activator and emits each
   * pending skill's body as a single reminder block. we fire this once
   * per skill per session, so the body lands in the conversation right
   * after the Read that triggered it.
   */
  conditionalSkillActivation(
    activator: SkillActivator,
    skillsByName: Map<string, SkillMetadata>,
  ): Reminder {
    const bodyCache = new Map<string, string>()
    return {
      name: 'skill-activated',
      shouldFire() {
        const drained = activator.drain()
        if (drained.length === 0) return null
        const bodies: string[] = []
        for (const name of drained) {
          const meta = skillsByName.get(name)
          if (!meta) continue
          let body = bodyCache.get(name)
          if (body === undefined) {
            try {
              body = readSkillBody(meta.path)
            } catch {
              continue
            }
            bodyCache.set(name, body)
          }
          bodies.push(`## Skill activated: ${name}\n${meta.description}\n\n${body}`)
        }
        return bodies.length === 0 ? null : bodies.join('\n\n---\n\n')
      },
    }
  },

  /**
   * Proactive `<file_state>` reminder. The harness surfaces a one-line listing of
   * "files you've already read this session" so the model doesn't blindly
   * Read them again. Fires every turn the cache changed; capped at 30
   * entries to keep the reminder small.
   *
   * The listing intentionally includes mtimes so the model can correlate
   * a "did this file change?" question against its prior read snapshot.
   */
  fileStateContext(
    fileStateCache: FileStateCache & { entries?: () => Iterable<[string, number]> },
    cap = 30,
  ): Reminder {
    let lastFingerprint = ''
    return {
      name: 'file-state',
      shouldFire(ctx) {
        const entries = collectCacheEntries(fileStateCache)
        if (entries.length === 0) return null
        // Hash the (path, mtime) pairs so we re-emit only when something
        // changed (new read, mtime advanced, etc.).
        const fp = entries
          .map(([p, m]) => `${p}@${m}`)
          .sort()
          .join('|')
        if (fp === lastFingerprint) return null
        lastFingerprint = fp
        const shown = entries.slice(0, cap)
        const lines = shown.map(([p, m]) => `  - ${p} (mtime ${formatMtime(m)})`)
        const tail =
          entries.length > cap
            ? `\n  ... ${entries.length - cap} more`
            : ''
        void ctx.turn // silence unused warning
        return `Files already Read this session (no need to re-Read unless mtime changed):\n${lines.join('\n')}${tail}`
      },
    }
  },

  /**
   * Cwd drift reminder. The persistent shell tracks the live cwd after
   * every Bash call (because the shell honors `cd`). The system prompt's
   * env block was baked at construction time. When the live cwd diverges
   * — usually because the model ran `cd somewhere` — the model's mental
   * model of "where am I" silently goes stale. Fires once per drift event.
   */
  cwdDrift(getLiveCwd: () => string, baselineCwd: string): Reminder {
    let lastFiredFor = ''
    return {
      name: 'cwd-drift',
      shouldFire() {
        const live = getLiveCwd()
        if (live === baselineCwd) return null
        if (live === lastFiredFor) return null
        lastFiredFor = live
        return `Working directory has drifted from ${baselineCwd} to ${live} (likely a Bash \`cd\`). The Read/Write/Edit tools still take ABSOLUTE paths — the drift only affects relative-path bash invocations. If the new cwd is incorrect, run \`cd ${baselineCwd}\` to return.`
      },
    }
  },

  /**
   * Monitor exit notifier. Drains the registry's pending exits each turn
   * and emits a one-shot reminder per exited job.
   */
  monitorExits(registry: MonitorRegistry): Reminder {
    return {
      name: 'monitor-exit',
      shouldFire() {
        const exited = registry.drainExits()
        if (exited.length === 0) return null
        return exited
          .map(j => {
            const dur = j.exitedAt
              ? `${Math.round((j.exitedAt - j.startedAt) / 1000)}s`
              : '?'
            return `Monitor ${j.id} (${j.description}) ${j.status} after ${dur}, exit ${j.exitCode ?? 'unknown'}. Read ${j.outputPath} for output.`
          })
          .join('\n')
      },
    }
  },

  /**
   * Context-bloat advisor. Each turn, attribute rough tokens to each tool;
   * when one tool dominates the budget, emit a typed suggestion ("Bash
   * output is 32% — pipe through head"). Fires only when total context
   * exceeds `minTotalTokens` (default 20k) so we don't pester early-session.
   */
  contextBloat(
    getMessages: () => BloatMessage[],
    options: AnalyzeBloatOptions & { minTotalTokens?: number } = {},
  ): Reminder {
    const minTotal = options.minTotalTokens ?? 20_000
    let lastSummary = ''
    return {
      name: 'context-bloat',
      shouldFire() {
        const messages = getMessages()
        const analysis = analyzeContextBloat(messages, options)
        if (analysis.totalTokens < minTotal) return null
        if (analysis.suggestions.length === 0) return null
        const lines = analysis.suggestions.map(s => `- [${s.severity}] ${s.message}`)
        const summary = lines.join('\n')
        if (summary === lastSummary) return null
        lastSummary = summary
        return `Context bloat detected (~${Math.round(analysis.totalTokens / 1000)}K tokens):\n${summary}`
      },
    }
  },

  /**
   * Auto-compact pre-warning. Fires when the conversation's rough token
   * count exceeds `warnAt` but is still under the summarization trigger.
   * Lets the model know it should wrap up loose ends or write findings to
   * disk before history collapses into a summary.
   *
   * `getRoughTokens` is injected so the reminder doesn't have to import
   * langchain to compute its own estimate.
   */
  autoCompactWarning(
    getRoughTokens: () => number,
    warnAt: number,
    triggerAt: number,
  ): Reminder {
    let warned = false
    return {
      name: 'auto-compact-warning',
      shouldFire() {
        const tokens = getRoughTokens()
        if (tokens < warnAt) {
          warned = false
          return null
        }
        if (tokens >= triggerAt) return null // summarization is about to fire anyway
        if (warned) return null
        warned = true
        const used = Math.round(tokens / 1000)
        const cap = Math.round(triggerAt / 1000)
        return `Conversation is ~${used}K tokens (compaction triggers at ~${cap}K). Wrap up open threads, persist important findings to disk via Write or Edit, and prefer concise replies until then.`
      },
    }
  },
}

export type CCReminderFactory = typeof ccReminders

function collectCacheEntries(
  cache: FileStateCache & { entries?: () => Iterable<[string, number]> },
): Array<[string, number]> {
  if (typeof cache.entries === 'function') return [...cache.entries()]
  return []
}

function formatMtime(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return 'unknown'
  return new Date(ms).toISOString().slice(0, 19).replace('T', ' ')
}

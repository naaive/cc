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

import type { Todo } from '../tools/writeTodos.js'
import type { PermissionMode } from '../permissionMode.js'

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
 * cc-aligned reminders. Each is a factory so closures can hold their own
 * "last fired at" cache without leaking across middleware instances.
 */
export const ccReminders = {
  /**
   * Re-inject the full todo list every turn (cc behavior). The model treats
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
   * Persistent warning while plan mode is active. cc fires this every turn
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

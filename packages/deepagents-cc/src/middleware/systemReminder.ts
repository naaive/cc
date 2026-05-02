/**
 * System-reminder middleware — cc's "<system-reminder>" injection mechanism.
 *
 * cc periodically injects short reminders into the user's turn (todo state,
 * stale plan warning, "use TodoWrite", etc.) by appending a
 * `<system-reminder>...</system-reminder>` block to the user message. Those
 * blocks are rendered to the model but not to the user.
 *
 * This middleware exposes a list of `Reminder` rules that are evaluated
 * before each user turn. Each rule decides whether it should fire and
 * returns the text to append. Stateful rules can read/write
 * `state.reminderState` to track when they last fired.
 */

import {
  createMiddleware,
  HumanMessage,
  type AgentMiddleware,
  type BaseMessage,
} from 'langchain'
import { z } from 'zod/v4'

export interface ReminderContext {
  state: Record<string, unknown>
  /** Number of user-turns elapsed in this run. */
  turn: number
  /** Last user message text (best effort: joined string content). */
  lastUserText: string
}

export interface Reminder {
  name: string
  /** Return reminder text to inject, or null/undefined to skip. */
  shouldFire(ctx: ReminderContext): string | null | undefined
}

const stateSchema = z.object({
  reminderState: z.record(z.string(), z.unknown()).default({}),
  __turnCount: z.number().int().nonnegative().default(0),
})

export interface SystemReminderMiddlewareOptions {
  reminders: Reminder[]
}

export function createSystemReminderMiddleware(
  options: SystemReminderMiddlewareOptions,
): AgentMiddleware {
  return createMiddleware({
    name: 'SystemReminderMiddleware',
    stateSchema,
    beforeModel: (state: {
      messages: BaseMessage[]
      reminderState?: Record<string, unknown>
      __turnCount?: number
    }) => {
      const turn = (state.__turnCount ?? 0) + 1
      const lastUser = findLastUser(state.messages)
      if (!lastUser) return { __turnCount: turn }
      const ctx: ReminderContext = {
        state: state.reminderState ?? {},
        turn,
        lastUserText: messageToString(lastUser),
      }
      const fired = options.reminders
        .map(r => ({ name: r.name, text: r.shouldFire(ctx) }))
        .filter((r): r is { name: string; text: string } => Boolean(r.text))

      if (fired.length === 0) return { __turnCount: turn }

      const block = fired
        .map(f => `<system-reminder name="${f.name}">${f.text}</system-reminder>`)
        .join('\n')

      // Append the reminder by replacing the last user message in-place.
      // We avoid mutating the original by creating a new HumanMessage
      // composed of the original text plus the reminder block.
      const next = new HumanMessage(`${ctx.lastUserText}\n\n${block}`)
      const messages = [...state.messages]
      messages[messages.lastIndexOf(lastUser)] = next
      return { messages, __turnCount: turn }
    },
  })
}

function findLastUser(messages: BaseMessage[]): BaseMessage | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.getType() === 'human') return messages[i]
  }
  return undefined
}

function messageToString(msg: BaseMessage): string {
  const content = msg.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map(part =>
        typeof part === 'string'
          ? part
          : 'text' in part && typeof part.text === 'string'
            ? part.text
            : '',
      )
      .filter(Boolean)
      .join('\n')
  }
  return ''
}

/**
 * Stock cc-style reminders.
 *
 * - todoStaleReminder: nudge the model to use TodoWrite when no todo exists.
 * - planModeReminder: when plan mode is active, remind every turn.
 */
export const stockReminders = {
  todoStale(): Reminder {
    return {
      name: 'todo-stale',
      shouldFire(ctx) {
        const lastFiredAt = (ctx.state['todoStale.lastTurn'] as number | undefined) ?? 0
        if (ctx.turn - lastFiredAt < 6) return null
        ctx.state['todoStale.lastTurn'] = ctx.turn
        return 'The TodoWrite tool hasn\'t been used recently. If your work spans 3+ steps, consider using it to track progress.'
      },
    }
  },
  planModeActive(getMode: () => string): Reminder {
    return {
      name: 'plan-mode-active',
      shouldFire() {
        return getMode() === 'plan'
          ? 'Plan mode is active. You may read and analyze, but every write/edit/delete tool is denied. Call exit_plan_mode once your plan is ready.'
          : null
      },
    }
  },
  customMessage(name: string, text: string, everyNTurns = 1): Reminder {
    return {
      name,
      shouldFire(ctx) {
        const key = `customMessage.${name}.lastTurn`
        const last = (ctx.state[key] as number | undefined) ?? -Infinity
        if (ctx.turn - last < everyNTurns) return null
        ctx.state[key] = ctx.turn
        return text
      },
    }
  },
}

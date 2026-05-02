/**
 * Context-engineering middleware — cc's `<system-reminder>` injection
 * mechanism. The actual reminder factories live in `./reminders.ts` so
 * they stay pure (no langchain runtime).
 *
 * Every turn, before the model runs, we:
 *  1. Snapshot the latest user message text.
 *  2. Ask each registered reminder whether it wants to fire.
 *  3. Append the fired reminders as one `<system-reminder>...</...>` block
 *     to that user message.
 *
 * The model sees these reminders inline; the user does not. This is how
 * cc keeps todo state, plan-mode banners, and similar "this is true RIGHT
 * NOW" facts in front of the model without bloating the conversation
 * history.
 */

import {
  createMiddleware,
  HumanMessage,
  type AgentMiddleware,
  type BaseMessage,
} from 'langchain'
import { z } from 'zod/v4'
import { ccReminders, type Reminder, type ReminderContext } from './reminders.js'
import type { Todo } from '../tools/writeTodos.js'
import type { PermissionMode } from '../permissionMode.js'

export { ccReminders, type Reminder, type ReminderContext }
export type CCReminderFactory = typeof ccReminders

const stateSchema = z.object({
  todos: z.array(z.unknown()).default([]),
  permissionMode: z
    .enum(['default', 'acceptEdits', 'plan', 'bypassPermissions'])
    .default('default'),
  reminderState: z.record(z.string(), z.unknown()).default({}),
  __turnCount: z.number().int().nonnegative().default(0),
})

export interface ContextEngineeringMiddlewareOptions {
  reminders: Reminder[]
}

export function createContextEngineeringMiddleware(
  options: ContextEngineeringMiddlewareOptions,
): AgentMiddleware {
  return createMiddleware({
    name: 'ContextEngineeringMiddleware',
    stateSchema,
    beforeModel: (state: {
      messages: BaseMessage[]
      todos?: Todo[]
      permissionMode?: PermissionMode
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
        todos: state.todos ?? [],
        permissionMode: state.permissionMode ?? 'default',
      }
      const fired = options.reminders
        .map(r => ({ name: r.name, text: r.shouldFire(ctx) }))
        .filter((r): r is { name: string; text: string } => Boolean(r.text))

      if (fired.length === 0) return { __turnCount: turn }

      const block = fired
        .map(f => `<system-reminder name="${f.name}">${f.text}</system-reminder>`)
        .join('\n')

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

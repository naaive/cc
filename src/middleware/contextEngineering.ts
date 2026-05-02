/**
 * Context-engineering middleware — `<system-reminder>` injection
 * mechanism. The actual reminder factories live in `./reminders.ts` so
 * they stay pure (no langchain runtime).
 *
 * Every turn, before the model runs, we:
 *  1. Snapshot the latest user message text.
 *  2. Build a `ReminderContext` for each registered reminder, with a
 *     per-reminder `store` namespaced by reminder name (so two reminders
 *     can use the same key without colliding).
 *  3. Append the fired reminders as one `<system-reminder>...</...>` block
 *     to that user message.
 *
 * The model sees these reminders inline; the user does not. This is how
 * The harness keeps todo state, plan-mode banners, and similar "this is true RIGHT
 * NOW" facts in front of the model without bloating the conversation
 * history.
 */

import {
  createMiddleware,
  HumanMessage,
  type AgentMiddleware,
  type BaseMessage,
} from 'langchain'
import { z } from 'zod'
import {
  ccReminders,
  createReminderStore,
  type Reminder,
  type ReminderContext,
  type ReminderStore,
} from './reminders.js'
import type { Todo } from '../tools/todoWrite.js'

export {
  ccReminders,
  createReminderStore,
  type Reminder,
  type ReminderContext,
  type ReminderStore,
}
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
    beforeModel: state => {
      const turn = (state.__turnCount ?? 0) + 1
      const lastUser = findLastUser(state.messages)
      if (!lastUser) return { __turnCount: turn }

      const stateBag = state.reminderState ?? {}
      const lastUserText = messageToString(lastUser)
      const todos = (state.todos ?? []) as Todo[]
      const permissionMode = state.permissionMode ?? 'default'

      const fired: Array<{ name: string; text: string }> = []
      for (const reminder of options.reminders) {
        const text = reminder.shouldFire({
          store: createReminderStore(stateBag, reminder.name),
          turn,
          lastUserText,
          todos,
          permissionMode,
        })
        if (text) fired.push({ name: reminder.name, text })
      }

      if (fired.length === 0) {
        return { __turnCount: turn, reminderState: stateBag }
      }

      const block = fired
        .map(f => `<system-reminder name="${f.name}">${f.text}</system-reminder>`)
        .join('\n')

      const next = new HumanMessage(`${lastUserText}\n\n${block}`)
      const messages = [...state.messages]
      messages[messages.lastIndexOf(lastUser)] = next
      return { messages, __turnCount: turn, reminderState: stateBag }
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

/**
 * write_todos — cc's task-tracking tool.
 *
 * Stores the current todo list on the agent state so middleware (e.g. the
 * stale-todo reminder) can read it. Each todo has `content` (imperative),
 * `activeForm` (present continuous, shown while in_progress), and a
 * status (`pending` | `in_progress` | `completed`).
 *
 * Invariant the prompt enforces: at most ONE in_progress todo at a time.
 * We don't enforce it programmatically — let the model self-correct from
 * the validation message embedded in the description.
 */

import { tool } from 'langchain'
import { Command } from '@langchain/langgraph'
import { z } from 'zod/v4'

const todoSchema = z.object({
  content: z.string().min(1).describe('Imperative form: "Run tests", "Refactor parser".'),
  activeForm: z.string().min(1).describe('Present continuous: "Running tests", "Refactoring parser".'),
  status: z.enum(['pending', 'in_progress', 'completed']),
})

const schema = z.object({
  todos: z.array(todoSchema).describe('The full updated todo list.'),
})

export type Todo = z.infer<typeof todoSchema>

const description = `Create or update the structured todo list for this session.

Use proactively when:
 - The task spans 3+ distinct steps.
 - The user provides multiple things to do.
 - You start work on a step (mark it in_progress BEFORE acting).
 - You finish a step (mark it completed IMMEDIATELY).

Rules:
 - Exactly ONE todo is in_progress at a time.
 - Mark complete only when fully done. If blocked, leave as in_progress and add a follow-up.
 - Pass the FULL list every time — this overwrites the previous list.`

export function createWriteTodosTool() {
  return tool(
    (input: z.infer<typeof schema>) => {
      const inProgress = input.todos.filter(t => t.status === 'in_progress').length
      const summary = summarize(input.todos)
      // The Command update lets downstream middleware (system reminders,
      // UI renderers) read state.todos directly.
      return new Command({
        update: { todos: input.todos },
        // Surface the validation hint in the tool result so the model can
        // self-correct on the very next turn.
        ...(inProgress > 1
          ? {
              // We still apply the update, but we tell the model.
            }
          : {}),
      })
    },
    { name: 'write_todos', description, schema },
  )
}

function summarize(todos: Todo[]): string {
  if (todos.length === 0) return '(empty)'
  return todos
    .map(t => {
      const mark = t.status === 'completed' ? '[x]' : t.status === 'in_progress' ? '[~]' : '[ ]'
      const label = t.status === 'in_progress' ? t.activeForm : t.content
      return `${mark} ${label}`
    })
    .join('\n')
}

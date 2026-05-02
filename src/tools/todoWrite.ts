/**
 * TodoWrite — name + description.
 *
 * Stores the current todo list on the agent state (`state.todos`) so the
 * SystemReminder middleware can re-inject it into every subsequent user
 * turn. The model is expected to pass the FULL list every time —
 * partial-update semantics get confusing fast, especially under
 * compaction.
 */

import { tool } from 'langchain'
import { Command } from '@langchain/langgraph'
import { z } from 'zod'
import { TOOL_DESCRIPTIONS, TOOL_NAMES } from './toolNames.js'

const todoSchema = z.object({
  content: z.string().min(1).describe('Imperative form: "Run tests", "Refactor parser".'),
  activeForm: z.string().min(1).describe('Present continuous: "Running tests", "Refactoring parser".'),
  status: z.enum(['pending', 'in_progress', 'completed']),
})

const schema = z.object({
  todos: z.array(todoSchema).describe('The full updated todo list.'),
})

export type Todo = z.infer<typeof todoSchema>

export function createTodoWriteTool() {
  return tool(
    (input: z.infer<typeof schema>) => {
      return new Command({ update: { todos: input.todos } })
    },
    {
      name: TOOL_NAMES.TodoWrite,
      description: TOOL_DESCRIPTIONS.TodoWrite,
      schema,
    },
  )
}

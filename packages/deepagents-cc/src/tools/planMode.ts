/**
 * Plan mode tools — `enter_plan_mode` and `exit_plan_mode`.
 *
 * cc lets the user (and the model) flip the agent into a read-only mode
 * where every write tool is denied. The model uses `enter_plan_mode` when
 * the request is "plan first, then act" and `exit_plan_mode` once the plan
 * is approved. Toggling is done through shared state — tools mutate
 * `state.permissionMode`, the permission middleware reads it.
 */

import { tool } from 'langchain'
import { Command } from '@langchain/langgraph'
import { z } from 'zod/v4'
import { PERMISSION_MODES, type PermissionMode } from '../permissionMode.js'

const enterSchema = z.object({})

const exitSchema = z.object({
  plan: z
    .string()
    .min(1)
    .describe('The agreed-upon plan, in markdown. Shown to the user for confirmation before any write happens.'),
})

const ENTER_DESC = `Enter Plan Mode. While in plan mode you may read files, run read-only commands, and use search/grep, but every write/edit/delete tool is denied. Use this when the user asks for a plan, a design, or wants to discuss before acting.`

const EXIT_DESC = `Exit Plan Mode. Submit the final plan for the user to approve. Only call this once the plan is fleshed out and ready to execute.`

export function createEnterPlanModeTool() {
  return tool(
    async () => {
      return new Command({
        update: { permissionMode: 'plan' satisfies PermissionMode },
      })
    },
    { name: 'enter_plan_mode', description: ENTER_DESC, schema: enterSchema },
  )
}

export function createExitPlanModeTool() {
  return tool(
    async (input: z.infer<typeof exitSchema>) => {
      return new Command({
        update: {
          permissionMode: 'default' satisfies PermissionMode,
          // Stash the plan so a UI / hook can surface it to the user.
          pendingPlan: input.plan,
        },
        // Surface the plan as the tool result so the model can reference it.
        // The permission middleware is responsible for blocking writes
        // until the user explicitly approves.
      })
    },
    { name: 'exit_plan_mode', description: EXIT_DESC, schema: exitSchema },
  )
}

export const PLAN_MODE_TOOL_NAMES = ['enter_plan_mode', 'exit_plan_mode'] as const
export { PERMISSION_MODES }

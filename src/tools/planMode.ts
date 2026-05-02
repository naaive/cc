/**
 * ExitPlanMode — . We do NOT expose `EnterPlanMode` as a tool;
 * plan mode is entered by the user (CLI flag, slash command, or initial
 * setting). The model can only *exit* plan mode by submitting a plan for
 * the user to approve.
 *
 * The tool emits a Command update that flips `state.permissionMode` back
 * to `default` and stashes the proposed plan on `state.pendingPlan` so a
 * UI / hook layer can surface it for explicit approval.
 */

import { tool } from 'langchain'
import { Command } from '@langchain/langgraph'
import { z } from 'zod/v4'
import { TOOL_DESCRIPTIONS, TOOL_NAMES } from './toolNames.js'
import type { PermissionMode } from '../permissionMode.js'

const exitSchema = z.object({
  plan: z
    .string()
    .min(1)
    .describe('The plan you want the user to approve, in markdown.'),
})

export function createExitPlanModeTool() {
  return tool(
    (input: z.infer<typeof exitSchema>) => {
      return new Command({
        update: {
          permissionMode: 'default' satisfies PermissionMode,
          pendingPlan: input.plan,
        },
      })
    },
    {
      name: TOOL_NAMES.ExitPlanMode,
      description: TOOL_DESCRIPTIONS.ExitPlanMode,
      schema: exitSchema,
    },
  )
}

export const PLAN_MODE_TOOL_NAMES = ['ExitPlanMode'] as const

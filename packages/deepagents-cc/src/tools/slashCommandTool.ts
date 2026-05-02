/**
 * SlashCommand tool — let the model invoke a slash command.
 */

import { tool } from 'langchain'
import { z } from 'zod/v4'
import { builtinCommands, type SlashCommand } from '../slashCommands/builtin.js'
import { parseSlashCommand } from '../slashCommands/parse.js'
import type { PermissionMode } from '../permissionMode.js'
import { TOOL_DESCRIPTIONS, TOOL_NAMES } from './ccToolNames.js'

const schema = z.object({
  command: z
    .string()
    .min(1)
    .describe('Slash command, with or without a leading slash. Example: "mode plan", "/init", "memory remember to use snake_case".'),
})

const noop = (): void => {}

export interface SlashCommandToolOptions {
  cwd?: string
  /** Custom commands beyond the built-ins. */
  extraCommands?: SlashCommand[]
  /** Allow-list of command names. When set, every other command is denied. */
  allowedCommands?: string[]
  onPrint?: (text: string) => void
  setPermissionMode?: (mode: PermissionMode) => void
  clearHistory?: () => void
  appendMemory?: (scope: 'user' | 'project', text: string) => void
}

export function createSlashCommandTool(options: SlashCommandToolOptions = {}) {
  const allowed = options.allowedCommands
    ? new Set(options.allowedCommands)
    : null
  const all = [...builtinCommands, ...(options.extraCommands ?? [])]

  return tool(
    async (input: z.infer<typeof schema>) => {
      const raw = input.command.startsWith('/') ? input.command : `/${input.command}`
      const parsed = parseSlashCommand(raw)
      if (!parsed) return `failed to parse command: ${input.command}`
      if (allowed && !allowed.has(parsed.name)) {
        return `command /${parsed.name} is not allowed`
      }
      const cmd = all.find(c => c.name === parsed.name)
      if (!cmd) return `unknown command: /${parsed.name}`

      const captured: string[] = []
      await cmd.run(parsed.args, {
        cwd: options.cwd ?? process.cwd(),
        setPermissionMode: options.setPermissionMode ?? noop,
        clearHistory: options.clearHistory ?? noop,
        appendMemory: options.appendMemory ?? noop,
        print: text => {
          captured.push(text)
          options.onPrint?.(text)
        },
      })
      return captured.length === 0
        ? `/${parsed.name} ran (no output)`
        : captured.join('\n')
    },
    {
      name: TOOL_NAMES.SlashCommand,
      description: TOOL_DESCRIPTIONS.SlashCommand,
      schema,
    },
  )
}

/**
 * SlashCommand tool — let the model invoke a slash command.
 *
 * cc exposes its slash commands (`/init`, `/compact`, `/memory`, `/mode`,
 * `/clear`, …) both to the user (REPL) and to the model (via this tool).
 * Letting the model trigger them is useful for self-service flows: the
 * model decides "I want to switch to plan mode" or "I should compact
 * before continuing", calls `SlashCommand { command: "mode plan" }`, and
 * the harness runs the matching command's handler.
 *
 * The tool is gated by an allow-list (default: every built-in command).
 * Custom commands the host registered are also reachable; commands that
 * touch user state (memory, mode) are still safe because their `run`
 * handlers do their own checks.
 */

import { tool } from 'langchain'
import { z } from 'zod/v4'
import { findCommand, builtinCommands, type SlashCommand } from '../slashCommands/builtin.js'
import { parseSlashCommand } from '../slashCommands/parse.js'

const schema = z.object({
  command: z
    .string()
    .min(1)
    .describe('Slash command, with or without a leading slash. Example: "mode plan", "/init", "memory remember to use snake_case".'),
})

const description = `Invoke a slash command from inside the agent.

Use this when you decide a command would help — e.g. /mode plan to flip into read-only investigation, /memory to record a project convention, /compact to free up context. The harness runs the command's handler; the textual output (if any) becomes this tool's result.

Available commands depend on the host. Built-ins typically include: /clear, /help, /init, /compact, /memory, /mode.`

export interface SlashCommandToolOptions {
  /** Working directory passed to command handlers. */
  cwd?: string
  /** Custom commands beyond the built-ins. */
  extraCommands?: SlashCommand[]
  /** Allow-list of command names. When set, every other command is denied. */
  allowedCommands?: string[]
  /** Report progress / results back to the harness for UI rendering. */
  onPrint?: (text: string) => void
  setPermissionMode?: (mode: 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions') => void
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
      const cmd = all.find(c => c.name === parsed.name) ?? findCommand(parsed.name)
      if (!cmd) return `unknown command: /${parsed.name}`

      const captured: string[] = []
      await cmd.run(parsed.args, {
        cwd: options.cwd ?? process.cwd(),
        setPermissionMode: m => {
          options.setPermissionMode?.(m)
        },
        clearHistory: () => {
          options.clearHistory?.()
        },
        appendMemory: (scope, text) => {
          options.appendMemory?.(scope, text)
        },
        print: text => {
          captured.push(text)
          options.onPrint?.(text)
        },
      })
      return captured.length === 0
        ? `/${parsed.name} ran (no output)`
        : captured.join('\n')
    },
    { name: 'SlashCommand', description, schema },
  )
}

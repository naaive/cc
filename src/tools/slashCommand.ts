/**
 * SlashCommand tool — let the model invoke a user-defined custom command.
 *
 * Custom commands live in `.forge/commands/<name>.md` (and `~/.forge/...`).
 * The model picks one by name, optionally passes args, and gets back the
 * EXPANDED prompt template (with `$ARGUMENTS` / `!`bash / `@file` already
 * substituted). The model treats the result as the user's intent and
 * proceeds.
 *
 * This is opt-in (only registered when commands are configured) so the
 * library stays usable without a commands directory.
 */

import { tool } from 'langchain'
import { z } from 'zod'
import { expandCommandBody, type ExpanderOptions } from '../commands/expander.js'
import type { CustomCommand } from '../commands/loader.js'

export interface SlashCommandToolOptions {
  /** Live registry of commands. Read each call so runtime additions show up. */
  getCommands: () => CustomCommand[]
  /** Working directory passed to the expander. */
  cwd: string
  /** Override the bash runner (e.g. plug in PersistentShell). */
  runBash?: ExpanderOptions['runBash']
  /** Override the file reader. */
  readFile?: ExpanderOptions['readFile']
  /** Cap inlined output. */
  maxInlineChars?: number
}

const description = `Invoke a user-defined custom command from .forge/commands/.

Each command is a prompt template authored by the user. Calling SlashCommand expands the template — substituting $ARGUMENTS, running !bash lines, inlining @file references — and returns the result. Treat that result as instructions you should follow.

Use this when the user installed a workflow command and the current task matches its purpose (e.g. /commit-and-push, /review, /lint). Call DiscoverSlashCommands first if you don't know what's available.`

const discoverDescription = `List user-defined custom commands installed in .forge/commands/.

Returns name + description for each so you can pick the right one before calling SlashCommand.`

export function createSlashCommandTool(options: SlashCommandToolOptions) {
  const names = () => options.getCommands().map(c => c.name)
  const schema = z.object({
    name: z
      .string()
      .min(1)
      .describe('Command name (without leading "/"). Use DiscoverSlashCommands to list.'),
    args: z
      .string()
      .optional()
      .describe('Arguments to substitute for $ARGUMENTS in the command template.'),
  })

  return tool(
    async (input: z.infer<typeof schema>) => {
      const cmd = options.getCommands().find(c => c.name === input.name)
      if (!cmd) {
        const available = names()
        return `unknown command: ${input.name}. Available: ${available.length > 0 ? available.join(', ') : '(none)'}`
      }
      const expanded = await expandCommandBody(cmd.body, input.args ?? '', {
        cwd: options.cwd,
        runBash: options.runBash,
        readFile: options.readFile,
        maxInlineChars: options.maxInlineChars,
      })
      const header = `# Command: /${cmd.name}${cmd.description ? `\n${cmd.description}` : ''}\n\n`
      return header + expanded
    },
    { name: 'SlashCommand', description, schema },
  )
}

const discoverSchema = z.object({
  query: z
    .string()
    .optional()
    .describe('Optional substring filter on name or description.'),
})

export function createDiscoverSlashCommandsTool(options: {
  getCommands: () => CustomCommand[]
}) {
  return tool(
    (input: z.infer<typeof discoverSchema>) => {
      const all = options.getCommands()
      if (all.length === 0) return '(no custom commands installed)'
      const q = input.query?.toLowerCase().trim()
      const filtered = q
        ? all.filter(
            c =>
              c.name.toLowerCase().includes(q) ||
              (c.description ?? '').toLowerCase().includes(q),
          )
        : all
      if (filtered.length === 0) return `(no commands match "${q ?? ''}")`
      return filtered
        .map(c => {
          const head = `/${c.name} [${c.source}]${c.argumentHint ? ` ${c.argumentHint}` : ''}`
          const desc = c.description ? `\n  ${c.description}` : ''
          const tools = c.allowedTools ? `\n  allowed-tools: ${c.allowedTools}` : ''
          return `${head}${desc}${tools}`
        })
        .join('\n\n')
    },
    {
      name: 'DiscoverSlashCommands',
      description: discoverDescription,
      schema: discoverSchema,
    },
  )
}

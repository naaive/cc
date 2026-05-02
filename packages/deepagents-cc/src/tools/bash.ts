/**
 * Bash tool — backed by a persistent shell so `cd` and env changes survive
 * across calls, and gated by allow/deny pattern lists from settings.
 *
 * The pattern matcher is intentionally simple: a list of substrings. cc
 * uses richer matching (BashTool's allowedToolsRules), but a substring
 * filter covers the 95% case (block `rm -rf`, `git push --force`, ...) and
 * keeps the surface small enough to audit.
 */

import { tool } from 'langchain'
import { z } from 'zod/v4'
import { PersistentShell } from './persistentShell.js'

const DEFAULT_TIMEOUT_MS = 120_000
const MAX_TIMEOUT_MS = 600_000

const schema = z.object({
  command: z.string().min(1).describe('Shell command to run.'),
  description: z
    .string()
    .optional()
    .describe('Short (5-10 word) description for the user audit log.'),
  timeout: z
    .number()
    .int()
    .positive()
    .max(MAX_TIMEOUT_MS)
    .optional()
    .describe(`Optional timeout in ms (max ${MAX_TIMEOUT_MS}, default ${DEFAULT_TIMEOUT_MS}).`),
  run_in_background: z.boolean().optional().describe('Append `&` and detach.'),
})

const description = `Run a shell command and return its output.

Notes:
 - Persistent shell: \`cd\`, exported vars, and shell options carry across calls in this session.
 - Avoid using bash for things a dedicated tool does better: prefer read_file/edit_file/grep/glob/ls.
 - Output past 200KB is truncated. Each call has a default timeout of ${DEFAULT_TIMEOUT_MS}ms.
 - Always quote paths containing spaces. Don't pipe interactive commands.`

export interface BashToolOptions {
  cwd?: string
  env?: NodeJS.ProcessEnv
  shell?: string
  /** Substrings that are auto-blocked. Match is case-insensitive. */
  denyPatterns?: string[]
  /** When set, the command must contain at least one of these substrings. */
  allowPatterns?: string[]
  /** Inject a shared shell instance (test seam / per-session sharing). */
  shellInstance?: PersistentShell
}

export function createBashTool(options: BashToolOptions = {}) {
  const shell =
    options.shellInstance ??
    new PersistentShell({
      cwd: options.cwd,
      env: options.env,
      shell: options.shell,
    })

  const denies = (options.denyPatterns ?? []).map(s => s.toLowerCase())
  const allows = options.allowPatterns?.map(s => s.toLowerCase())

  return tool(
    async (input: z.infer<typeof schema>) => {
      const cmd = input.run_in_background ? `${input.command} &` : input.command
      const lower = cmd.toLowerCase()
      for (const deny of denies) {
        if (lower.includes(deny)) {
          return `refused: command contains denied pattern "${deny}"`
        }
      }
      if (allows && !allows.some(a => lower.includes(a))) {
        return `refused: command did not match any allowed pattern`
      }

      const timeout = Math.min(input.timeout ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS)
      const result = await shell.run(cmd, timeout)

      const parts: string[] = []
      if (result.stdout) parts.push(`stdout:\n${result.stdout.trimEnd()}`)
      if (result.stderr) parts.push(`stderr:\n${result.stderr.trimEnd()}`)
      if (parts.length === 0) parts.push('(no output)')

      const status = result.timedOut
        ? `timed out after ${timeout}ms`
        : `exit ${result.exitCode}`
      const trunc = result.truncated ? ' [truncated]' : ''
      const cwd = `cwd: ${result.cwd}`
      return `${parts.join('\n\n')}\n\n${status} | ${cwd} | ${result.durationMs}ms${trunc}`
    },
    { name: 'bash', description, schema },
  )
}

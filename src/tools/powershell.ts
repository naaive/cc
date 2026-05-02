/**
 * PowerShell tool — Windows-native equivalent of Bash. Mirrors the Bash
 * tool's surface (allow/deny patterns, persistent shell, output cap)
 * while sharing the underlying `BasePersistentShell` framing.
 *
 * Some PowerShell harnesses include elaborate command-semantics analysis
 * (destructive command warnings, path validation, cmdlet allow-listing).
 * We don't replicate that here — those checks belong in the host's hooks
 * / permission rules layer, not the tool itself, so the same gating
 * pipeline that protects Bash also protects PowerShell.
 */

import { tool } from 'langchain'
import { z } from 'zod'
import {
  PersistentPowerShell,
  type PersistentPowerShellOptions,
  type PowerShellResult,
} from './persistentShell.js'

export {
  PersistentPowerShell,
  type PersistentPowerShellOptions,
  type PowerShellResult,
} from './persistentShell.js'

const DEFAULT_TIMEOUT_MS = 120_000
const MAX_TIMEOUT_MS = 600_000

const schema = z.object({
  command: z.string().min(1).describe('PowerShell command (or script block).'),
  description: z
    .string()
    .optional()
    .describe('Short (5-10 word) description shown in audit logs.'),
  timeout: z
    .number()
    .int()
    .positive()
    .max(MAX_TIMEOUT_MS)
    .optional()
    .describe(`Optional timeout in ms (max ${MAX_TIMEOUT_MS}, default ${DEFAULT_TIMEOUT_MS}).`),
})

const description = `Run a PowerShell command and return its output. Windows-native equivalent of Bash.

Notes:
 - Persistent shell — Set-Location, $env:VAR assignments, and module imports carry across calls.
 - Avoid PowerShell when a dedicated tool fits: prefer Read / Edit / Glob / Grep.
 - Output past 200KB is truncated. Default timeout 120s.
 - The same Bash allow/deny pattern lists from settings apply; use them to restrict destructive cmdlets (Remove-Item -Recurse, etc.).`

export interface PowerShellToolOptions {
  cwd?: string
  env?: NodeJS.ProcessEnv
  shell?: string
  denyPatterns?: string[]
  allowPatterns?: string[]
  shellInstance?: PersistentPowerShell
}

export function createPowerShellTool(options: PowerShellToolOptions = {}) {
  const shell =
    options.shellInstance ??
    new PersistentPowerShell({
      cwd: options.cwd,
      env: options.env,
      shell: options.shell,
    })
  const denies = (options.denyPatterns ?? []).map(s => s.toLowerCase())
  const allows = options.allowPatterns?.map(s => s.toLowerCase())

  return tool(
    async (input: z.infer<typeof schema>): Promise<string> => {
      const cmd = input.command
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
      const result: PowerShellResult = await shell.run(cmd, timeout)
      const parts: string[] = []
      if (result.stdout) parts.push(`stdout:\n${result.stdout.trimEnd()}`)
      if (result.stderr) parts.push(`stderr:\n${result.stderr.trimEnd()}`)
      if (parts.length === 0) parts.push('(no output)')
      const status = result.timedOut
        ? `timed out after ${timeout}ms`
        : `exit ${result.exitCode}`
      const trunc = result.truncated ? ' [truncated]' : ''
      return `${parts.join('\n\n')}\n\n${status} | cwd: ${result.cwd} | ${result.durationMs}ms${trunc}`
    },
    { name: 'PowerShell', description, schema },
  )
}

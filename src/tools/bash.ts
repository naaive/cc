/**
 * Bash, BashOutput, KillShell — names + persistent shell + bg jobs.
 *
 * - Bash runs against the long-lived shell (cwd / exports / shell options
 *   persist across calls). With `run_in_background: true`, it spawns a
 *   detached child via the BackgroundJobRegistry and returns a `shell_id`
 *   the model can later poll with BashOutput or stop with KillShell.
 * - BashOutput returns *new* output since the last poll plus the current
 *   status — the model never sees stale repeated output.
 * - KillShell SIGTERMs (then SIGKILLs) a background job.
 *
 * Pattern allow/deny lists from settings are still honored (substring
 * match against the full command). Hooks (PreToolUse) layer on top.
 */

import { tool } from 'langchain'
import type { StructuredTool } from '@langchain/core/tools'
import { z } from 'zod/v4'
import { TOOL_DESCRIPTIONS, TOOL_NAMES } from './toolNames.js'
import {
  BackgroundJobRegistry,
  PersistentShell,
} from './persistentShell.js'

const DEFAULT_TIMEOUT_MS = 120_000
const MAX_TIMEOUT_MS = 600_000

const bashSchema = z.object({
  command: z.string().min(1).describe('Shell command to run.'),
  description: z
    .string()
    .optional()
    .describe('Short (5-10 word) description shown in the user audit log.'),
  timeout: z
    .number()
    .int()
    .positive()
    .max(MAX_TIMEOUT_MS)
    .optional()
    .describe(`Optional timeout in ms (max ${MAX_TIMEOUT_MS}, default ${DEFAULT_TIMEOUT_MS}).`),
  run_in_background: z
    .boolean()
    .optional()
    .describe('Spawn the command as a detached background job. Returns a shell_id for BashOutput/KillShell.'),
})

const bashOutputSchema = z.object({
  shell_id: z.string().describe('shell_id returned by a previous Bash call with run_in_background=true.'),
})

const killShellSchema = z.object({
  shell_id: z.string().describe('shell_id of the background job to kill.'),
})

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
  /** Inject a shared registry (so BashOutput / KillShell see the same jobs). */
  jobRegistry?: BackgroundJobRegistry
}

export interface BashToolBundle {
  bash: StructuredTool
  bashOutput: StructuredTool
  killShell: StructuredTool
  shell: PersistentShell
  jobRegistry: BackgroundJobRegistry
}

export function createBashTools(options: BashToolOptions = {}): BashToolBundle {
  const shell =
    options.shellInstance ??
    new PersistentShell({
      cwd: options.cwd,
      env: options.env,
      shell: options.shell,
    })
  const jobRegistry = options.jobRegistry ?? new BackgroundJobRegistry()
  const denies = (options.denyPatterns ?? []).map(s => s.toLowerCase())
  const allows = options.allowPatterns?.map(s => s.toLowerCase())

  const bash = tool(
    async (input: z.infer<typeof bashSchema>) => {
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

      if (input.run_in_background) {
        const job = jobRegistry.spawn(
          cmd,
          options.cwd ?? process.cwd(),
          options.env ?? process.env,
        )
        return `started background job\nshell_id: ${job.id}\ncommand: ${job.command}\n\nUse BashOutput { shell_id: "${job.id}" } to read output, KillShell to stop it.`
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
      return `${parts.join('\n\n')}\n\n${status} | cwd: ${result.cwd} | ${result.durationMs}ms${trunc}`
    },
    {
      name: TOOL_NAMES.Bash,
      description: TOOL_DESCRIPTIONS.Bash,
      schema: bashSchema,
    },
  )

  const bashOutput = tool(
    (input: z.infer<typeof bashOutputSchema>) => {
      const polled = jobRegistry.poll(input.shell_id)
      if (!polled) return `unknown shell_id: ${input.shell_id}`
      const { job, newStdout, newStderr } = polled
      const parts: string[] = []
      if (newStdout) parts.push(`stdout (new):\n${newStdout.trimEnd()}`)
      if (newStderr) parts.push(`stderr (new):\n${newStderr.trimEnd()}`)
      if (parts.length === 0) parts.push('(no new output)')
      const status =
        job.status === 'running'
          ? 'running'
          : `${job.status}, exit ${job.exitCode ?? 'unknown'}`
      return `${parts.join('\n\n')}\n\nshell_id: ${job.id} | status: ${status}`
    },
    {
      name: TOOL_NAMES.BashOutput,
      description: TOOL_DESCRIPTIONS.BashOutput,
      schema: bashOutputSchema,
    },
  )

  const killShell = tool(
    (input: z.infer<typeof killShellSchema>) => {
      const ok = jobRegistry.kill(input.shell_id)
      return ok
        ? `killed ${input.shell_id}`
        : `could not kill ${input.shell_id} (already exited or unknown)`
    },
    {
      name: TOOL_NAMES.KillShell,
      description: TOOL_DESCRIPTIONS.KillShell,
      schema: killShellSchema,
    },
  )

  return { bash, bashOutput, killShell, shell, jobRegistry }
}

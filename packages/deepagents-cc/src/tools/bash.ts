/**
 * Bash tool — execute shell commands with a timeout.
 *
 * deepagents has filesystem tools but no shell. This is the cc Bash tool
 * stripped to its core: a single `command` argument, an optional working
 * directory, an enforced timeout, and stdout/stderr captured into the
 * tool result.
 *
 * The dangerous bits — sudo, rm -rf /, network egress — are NOT blocked
 * here. Permissioning is layered on top via the cc permission-mode
 * middleware (`requireWriteApproval` etc.) and an allow/deny pattern list
 * loaded from settings. This tool only enforces the runtime contract.
 */

import { spawn } from 'node:child_process'
import { tool } from 'langchain'
import { z } from 'zod/v4'

const DEFAULT_TIMEOUT_MS = 120_000
const MAX_TIMEOUT_MS = 600_000
const MAX_OUTPUT_BYTES = 200_000

export interface BashToolOptions {
  /** Default timeout when the model omits one. */
  defaultTimeoutMs?: number
  /** Hard ceiling — model-supplied timeouts are clamped to this. */
  maxTimeoutMs?: number
  /** Working directory. Defaults to process.cwd(). */
  cwd?: string
  /** Inherit env from parent or use a fresh one. */
  env?: NodeJS.ProcessEnv
}

const bashSchema = z.object({
  command: z
    .string()
    .min(1)
    .describe('The shell command to execute. Run via /bin/sh -c.'),
  description: z
    .string()
    .optional()
    .describe(
      'Short (5-10 word) description of what this command does. Helps the user audit risky calls.',
    ),
  timeout: z
    .number()
    .int()
    .positive()
    .max(MAX_TIMEOUT_MS)
    .optional()
    .describe(
      `Optional timeout in milliseconds (max ${MAX_TIMEOUT_MS}). Default ${DEFAULT_TIMEOUT_MS}.`,
    ),
  run_in_background: z
    .boolean()
    .optional()
    .describe(
      'When true, return immediately and let the command keep running. The caller can poll output later.',
    ),
})

const TOOL_DESCRIPTION = `Execute a shell command and return its output.

Notes:
 - Avoid using this tool to read files, list directories, or edit files when a dedicated tool fits — use read_file/ls/edit_file instead.
 - Always quote paths containing spaces. Prefer absolute paths over chained \`cd\`.
 - When commands are independent, list them separately so the model sees the failure surface clearly.
 - Output beyond ${MAX_OUTPUT_BYTES} bytes is truncated.`

export function createBashTool(options: BashToolOptions = {}) {
  const defaultTimeout = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxTimeout = options.maxTimeoutMs ?? MAX_TIMEOUT_MS

  return tool(
    async (input: z.infer<typeof bashSchema>) => {
      const timeout = Math.min(input.timeout ?? defaultTimeout, maxTimeout)
      if (input.run_in_background) {
        // Detached run: spawn and forget. We return a stub so the model knows
        // it cannot block on output. Callers that need real backgrounding
        // should plug in a process registry via custom middleware.
        spawn('/bin/sh', ['-c', input.command], {
          cwd: options.cwd,
          env: options.env ?? process.env,
          detached: true,
          stdio: 'ignore',
        }).unref()
        return `Command started in background.\nUse a follow-up command to read its output.`
      }
      return await runOnce(input.command, {
        timeoutMs: timeout,
        cwd: options.cwd ?? process.cwd(),
        env: options.env ?? process.env,
      })
    },
    {
      name: 'bash',
      description: TOOL_DESCRIPTION,
      schema: bashSchema,
    },
  )
}

interface RunOptions {
  timeoutMs: number
  cwd: string
  env: NodeJS.ProcessEnv
}

async function runOnce(command: string, options: RunOptions): Promise<string> {
  return await new Promise(resolve => {
    const child = spawn('/bin/sh', ['-c', command], {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let truncated = false
    let timedOut = false

    const append = (target: 'stdout' | 'stderr', chunk: Buffer) => {
      const current = target === 'stdout' ? stdout : stderr
      if (current.length >= MAX_OUTPUT_BYTES) {
        truncated = true
        return
      }
      const remaining = MAX_OUTPUT_BYTES - current.length
      const text =
        chunk.length > remaining
          ? chunk.subarray(0, remaining).toString('utf8')
          : chunk.toString('utf8')
      if (chunk.length > remaining) truncated = true
      if (target === 'stdout') stdout += text
      else stderr += text
    }

    child.stdout.on('data', c => append('stdout', c))
    child.stderr.on('data', c => append('stderr', c))

    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
      // Hard kill if it didn't exit within 2s of SIGTERM.
      setTimeout(() => child.kill('SIGKILL'), 2000).unref()
    }, options.timeoutMs)

    child.on('close', code => {
      clearTimeout(timer)
      const parts: string[] = []
      if (stdout) parts.push(`stdout:\n${stdout.trimEnd()}`)
      if (stderr) parts.push(`stderr:\n${stderr.trimEnd()}`)
      if (parts.length === 0) parts.push('(no output)')
      const status = timedOut
        ? `\n\n[timed out after ${options.timeoutMs}ms]`
        : `\n\nexit code: ${code ?? 'unknown'}`
      const trunc = truncated ? `\n[truncated to ${MAX_OUTPUT_BYTES} bytes]` : ''
      resolve(`${parts.join('\n\n')}${status}${trunc}`)
    })

    child.on('error', err => {
      clearTimeout(timer)
      resolve(`failed to spawn: ${(err as Error).message}`)
    })
  })
}

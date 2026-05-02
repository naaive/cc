/**
 * PowerShell tool — Windows-native persistent shell.
 *
 * Mirrors `Bash` for hosts deployed on Windows where `/bin/bash` isn't
 * available. Uses `pwsh` (PowerShell 7+) by default; falls back to
 * `powershell.exe` for legacy systems. cd / variables / functions persist
 * across calls via the same sentinel-framed long-lived child.
 *
 * Some PowerShell harnesses include elaborate command-semantics
 * analysis (destructive command warnings, path validation,
 * read-only-mode validation, cmdlet allow-listing). We don't replicate
 * that here — those checks belong in the host's hooks / permission rules
 * layer, not the tool itself, so the same gating pipeline that protects
 * Bash also protects PowerShell.
 */

import {
  type ChildProcess,
  type ChildProcessWithoutNullStreams,
  spawn,
} from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { tool } from 'langchain'
import { z } from 'zod/v4'

const DEFAULT_TIMEOUT_MS = 120_000
const MAX_TIMEOUT_MS = 600_000
const MAX_OUTPUT_BYTES = 200_000

export interface PowerShellResult {
  stdout: string
  stderr: string
  exitCode: number
  cwd: string
  truncated: boolean
  timedOut: boolean
  durationMs: number
}

export interface PersistentPowerShellOptions {
  cwd?: string
  env?: NodeJS.ProcessEnv
  /** Path to pwsh (or powershell.exe). Default: "pwsh". */
  shell?: string
}

export class PersistentPowerShell extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | null = null
  private readonly opts: PersistentPowerShellOptions
  private busy = false
  private _lastCwd: string

  constructor(opts: PersistentPowerShellOptions = {}) {
    super()
    this.opts = opts
    this._lastCwd = opts.cwd ?? process.cwd()
  }

  get lastCwd(): string {
    return this._lastCwd
  }

  start(): void {
    if (this.child) return
    const shellPath = this.opts.shell ?? 'pwsh'
    this.child = spawn(
      shellPath,
      ['-NoProfile', '-NonInteractive', '-NoLogo', '-Command', '-'],
      {
        cwd: this.opts.cwd ?? process.cwd(),
        env: { ...process.env, ...(this.opts.env ?? {}) },
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: true,
      },
    )
    this.child.unref()
    this.child.on('exit', () => {
      this.child = null
      this.emit('exit')
    })
    this.child.on('error', err => this.emit('error', err))
  }

  async run(
    command: string,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  ): Promise<PowerShellResult> {
    if (this.busy) {
      throw new Error('persistent PowerShell is busy — calls must be serialized')
    }
    this.busy = true
    this.start()
    const child = this.child
    if (!child) throw new Error('failed to start PowerShell')

    const sentinel = `__CCX_PSH_END_${randomUUID().replace(/-/g, '')}__`
    const startedAt = Date.now()

    return await new Promise<PowerShellResult>(resolve => {
      let stdout = ''
      let stderr = ''
      let truncated = false
      let timedOut = false
      let cwd = this.opts.cwd ?? process.cwd()

      const onStdout = (chunk: Buffer) => {
        const text = chunk.toString('utf8')
        const sentinelIdx = text.indexOf(sentinel)
        if (sentinelIdx === -1) {
          stdout = appendCapped(stdout, text, () => (truncated = true))
          return
        }
        stdout = appendCapped(stdout, text.slice(0, sentinelIdx), () => (truncated = true))
        const after = text.slice(sentinelIdx + sentinel.length + 1)
        const colonExit = after.indexOf(':')
        const newlineIdx = after.indexOf('\n')
        const exitCode = Number(after.slice(0, colonExit))
        cwd = after.slice(colonExit + 1, newlineIdx).trim() || cwd
        cleanup(exitCode)
      }
      const onStderr = (chunk: Buffer) => {
        stderr = appendCapped(stderr, chunk.toString('utf8'), () => (truncated = true))
      }
      const cleanup = (exitCode: number) => {
        clearTimeout(timer)
        child.stdout.off('data', onStdout)
        child.stderr.off('data', onStderr)
        this.busy = false
        this._lastCwd = cwd
        resolve({
          stdout,
          stderr,
          exitCode,
          cwd,
          truncated,
          timedOut,
          durationMs: Date.now() - startedAt,
        })
      }
      const timer = setTimeout(() => {
        timedOut = true
        this.stop()
        cleanup(124)
      }, timeoutMs)

      child.stdout.on('data', onStdout)
      child.stderr.on('data', onStderr)

      // PowerShell sentinel block: capture LASTEXITCODE + cwd in one Write-Host.
      // Single-line so the parser doesn't fight CRLF normalisation.
      const wrapped = `${command}\n$__rc=$LASTEXITCODE; if ($null -eq $__rc) { $__rc = 0 } ; Write-Host ("\`n${sentinel}:" + $__rc + ":" + (Get-Location).Path)\n`
      child.stdin.write(wrapped)
    })
  }

  stop(): void {
    if (!this.child) return
    try {
      this.child.kill('SIGTERM')
    } catch {
      // ignore
    }
    this.child = null
  }
}

function appendCapped(
  current: string,
  chunk: string,
  onTruncate: () => void,
): string {
  if (current.length >= MAX_OUTPUT_BYTES) {
    onTruncate()
    return current
  }
  const remaining = MAX_OUTPUT_BYTES - current.length
  if (chunk.length > remaining) {
    onTruncate()
    return current + chunk.slice(0, remaining)
  }
  return current + chunk
}

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
    async (input: z.infer<typeof schema>) => {
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
    { name: 'PowerShell', description, schema },
  )
}

// Internal helper exported for tests.
export type { ChildProcess as _ChildProcess }

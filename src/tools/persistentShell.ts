/**
 * Persistent shell — keeps `cwd`, env, and shell variables alive across
 * Bash tool calls. Plus a registry that backs the BashOutput /
 * KillShell tools by tracking detached background jobs spawned with
 * `run_in_background`.
 *
 * The Bash tool runs against a long-lived shell so `cd foo && pwd` and a
 * later `pwd` agree. The naive "spawn /bin/sh -c <cmd>" approach loses
 * that state. We keep a child shell open and stream commands through its
 * stdin, terminated by a sentinel, then read stdout/stderr until the
 * sentinel fires.
 *
 * Background jobs are kept in a separate map: each one is a fresh
 * non-persistent child whose stdout/stderr we accumulate. BashOutput
 * returns *new* output since the last poll; KillShell SIGTERMs the
 * process. This is the contract the model relies on so it can fire-
 * and-poll long-running commands.
 */

import {
  type ChildProcess,
  type ChildProcessWithoutNullStreams,
  spawn,
} from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'

const DEFAULT_TIMEOUT_MS = 120_000
const MAX_OUTPUT_BYTES = 200_000

export interface ShellResult {
  stdout: string
  stderr: string
  exitCode: number
  /** Resolved cwd AFTER the command, surfaced so the model can see `cd` results. */
  cwd: string
  truncated: boolean
  timedOut: boolean
  durationMs: number
}

export interface PersistentShellOptions {
  cwd?: string
  env?: NodeJS.ProcessEnv
  /** Path to the shell binary. Defaults to /bin/bash on unix. */
  shell?: string
}

export class PersistentShell extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | null = null
  private readonly opts: PersistentShellOptions
  private busy = false
  /** Last cwd reported by a successful `run()` — used by the cwd-drift reminder. */
  private _lastCwd: string

  constructor(opts: PersistentShellOptions = {}) {
    super()
    this.opts = opts
    this._lastCwd = opts.cwd ?? process.cwd()
  }

  /** Current cwd, as last reported by the shell. Updates after every run(). */
  get lastCwd(): string {
    return this._lastCwd
  }

  start(): void {
    if (this.child) return
    const shellPath = this.opts.shell ?? '/bin/bash'
    // No `-i`: interactive bash plays funny games with signals on a piped
    // stdin and corrupts our sentinel framing. We want a plain non-interactive
    // shell that nonetheless keeps state across stdin lines, which is the
    // default behaviour when stdin stays open.
    this.child = spawn(shellPath, ['--noprofile', '--norc'], {
      cwd: this.opts.cwd ?? process.cwd(),
      env: { ...process.env, ...(this.opts.env ?? {}), PS1: '' },
      stdio: ['pipe', 'pipe', 'pipe'],
      // detached so we own a process group; lets us SIGINT children
      // (e.g. a stuck `sleep`) without killing the shell itself.
      detached: true,
    })
    // Don't let the parent process wait on the shell.
    this.child.unref()
    this.child.on('exit', () => {
      this.child = null
      this.emit('exit')
    })
    this.child.on('error', err => {
      this.emit('error', err)
    })
  }

  async run(command: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<ShellResult> {
    if (this.busy) {
      throw new Error(
        'persistent shell is busy — bash tool calls must be serialized in this session',
      )
    }
    this.busy = true
    this.start()
    const child = this.child
    if (!child) throw new Error('failed to start persistent shell')

    const sentinel = `__CCX_END_${randomUUID().replace(/-/g, '')}__`
    const startedAt = Date.now()

    return await new Promise<ShellResult>(resolve => {
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
        // Sentinel format: __CCX_END_<id>__:<exitCode>:<cwd>\n
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
        // Tear down the whole shell. We can't reliably interrupt just the
        // child command from across a piped stdin, so the safer move is to
        // kill the shell and let the next call respawn. State (cwd, exports)
        // is lost — the alternative was zombie sleep processes hanging the
        // test runner, which is worse.
        this.stop()
        cleanup(124)
      }, timeoutMs)

      child.stdout.on('data', onStdout)
      child.stderr.on('data', onStderr)

      // Wrap the command so we capture exit code + cwd in one atomic line
      // emitted on stdout. `printf` (not echo) avoids trailing newlines
      // from interactive shells.
      const wrapped = `${command}\n__rc=$?; printf '\\n%s:%d:%s\\n' "${sentinel}" "$__rc" "$(pwd)"\n`
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

function appendCapped(current: string, chunk: string, onTruncate: () => void): string {
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

/**
 * Background-job registry. Each entry is a detached child process plus a
 * monotonically-growing buffer of its stdout/stderr. BashOutput hands the
 * model "what's new since last poll" by tracking a per-poll cursor; a
 * fresh BashOutput call advances the cursor.
 */
export interface BackgroundJob {
  id: string
  command: string
  startedAt: number
  status: 'running' | 'exited' | 'killed'
  exitCode: number | null
  /** Full stdout captured so far (capped at MAX_OUTPUT_BYTES). */
  stdout: string
  /** Full stderr captured so far (capped at MAX_OUTPUT_BYTES). */
  stderr: string
}

export class BackgroundJobRegistry {
  private readonly jobs = new Map<string, BackgroundJob>()
  private readonly children = new Map<string, ChildProcess>()
  /** Per-job cursor pointing to "next byte the model hasn't seen". */
  private readonly stdoutCursors = new Map<string, number>()
  private readonly stderrCursors = new Map<string, number>()

  spawn(
    command: string,
    cwd: string,
    env: NodeJS.ProcessEnv,
  ): BackgroundJob {
    const id = `bg_${randomUUID().slice(0, 8)}`
    const child = spawn('/bin/bash', ['--noprofile', '--norc', '-c', command], {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    })
    child.unref()

    const job: BackgroundJob = {
      id,
      command,
      startedAt: Date.now(),
      status: 'running',
      exitCode: null,
      stdout: '',
      stderr: '',
    }
    this.jobs.set(id, job)
    this.children.set(id, child)
    this.stdoutCursors.set(id, 0)
    this.stderrCursors.set(id, 0)

    let truncated = false
    child.stdout?.on('data', (chunk: Buffer) => {
      job.stdout = appendCapped(job.stdout, chunk.toString('utf8'), () => {
        truncated = true
      })
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      job.stderr = appendCapped(job.stderr, chunk.toString('utf8'), () => {
        truncated = true
      })
    })
    child.on('exit', code => {
      job.status = job.status === 'killed' ? 'killed' : 'exited'
      job.exitCode = code
      if (truncated) job.stdout += '\n[truncated]'
    })
    return job
  }

  poll(id: string): {
    job: BackgroundJob
    newStdout: string
    newStderr: string
  } | null {
    const job = this.jobs.get(id)
    if (!job) return null
    const sCur = this.stdoutCursors.get(id) ?? 0
    const eCur = this.stderrCursors.get(id) ?? 0
    const newStdout = job.stdout.slice(sCur)
    const newStderr = job.stderr.slice(eCur)
    this.stdoutCursors.set(id, job.stdout.length)
    this.stderrCursors.set(id, job.stderr.length)
    return { job, newStdout, newStderr }
  }

  kill(id: string): boolean {
    const child = this.children.get(id)
    const job = this.jobs.get(id)
    if (!child || !job) return false
    if (job.status !== 'running') return false
    try {
      child.kill('SIGTERM')
      job.status = 'killed'
      // Hard-kill if the child ignores SIGTERM.
      setTimeout(() => {
        if (job.status === 'killed' && child.exitCode == null) {
          try {
            child.kill('SIGKILL')
          } catch {
            /* ignore */
          }
        }
      }, 2000).unref()
      return true
    } catch {
      return false
    }
  }

  list(): BackgroundJob[] {
    return [...this.jobs.values()]
  }

  /** Tear down everything — used at shutdown. */
  stopAll(): void {
    for (const [, child] of this.children) {
      try {
        child.kill('SIGKILL')
      } catch {
        /* ignore */
      }
    }
    this.children.clear()
    this.jobs.clear()
    this.stdoutCursors.clear()
    this.stderrCursors.clear()
  }
}

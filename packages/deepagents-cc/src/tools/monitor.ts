/**
 * Monitor tool — long-running background process with completion notification.
 *
 * Different from `Bash run_in_background`:
 *   - Output is streamed to a file (model uses Read to inspect at any time)
 *     instead of buffered in memory.
 *   - When the process exits, a system-reminder is queued for the next user
 *     turn so the model learns about completion without polling.
 *
 * Use cases the model picks this for:
 *   - tail -f /var/log/app.log
 *   - while true; do curl -s ... ; sleep 5; done
 *   - inotifywait -m -r ./src
 *   - any "watch X and tell me when something happens" task
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { tool } from 'langchain'
import { z } from 'zod/v4'

export interface MonitoredJob {
  id: string
  command: string
  description: string
  outputPath: string
  startedAt: number
  status: 'running' | 'exited' | 'killed'
  exitCode: number | null
  exitedAt?: number
}

/**
 * Registry of monitored jobs. Owns the child processes, the output files,
 * and a notification queue the host (or our context-engineering middleware)
 * drains into a system-reminder on each user turn.
 */
export class MonitorRegistry {
  private readonly jobs = new Map<string, MonitoredJob>()
  private readonly children = new Map<string, ChildProcess>()
  /** Pending exit notifications — drain() returns and clears them. */
  private readonly pendingExits = new Set<string>()
  /** Where output files live; defaults to a private temp dir. */
  private readonly outputDir: string

  constructor(opts: { outputDir?: string } = {}) {
    this.outputDir =
      opts.outputDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'ccx-monitor-'))
  }

  spawn(args: { command: string; description: string; cwd: string }): MonitoredJob {
    const id = `mon_${randomUUID().slice(0, 8)}`
    const outputPath = path.join(this.outputDir, `${id}.log`)
    fs.writeFileSync(outputPath, '')
    const out = fs.openSync(outputPath, 'a')
    const child = spawn('/bin/bash', ['--noprofile', '--norc', '-c', args.command], {
      cwd: args.cwd,
      stdio: ['ignore', out, out],
      detached: true,
    })
    fs.closeSync(out)
    child.unref()
    const job: MonitoredJob = {
      id,
      command: args.command,
      description: args.description,
      outputPath,
      startedAt: Date.now(),
      status: 'running',
      exitCode: null,
    }
    this.jobs.set(id, job)
    this.children.set(id, child)
    child.on('exit', code => {
      job.status = job.status === 'killed' ? 'killed' : 'exited'
      job.exitCode = code
      job.exitedAt = Date.now()
      this.pendingExits.add(id)
    })
    return job
  }

  list(): MonitoredJob[] {
    return [...this.jobs.values()]
  }

  get(id: string): MonitoredJob | undefined {
    return this.jobs.get(id)
  }

  kill(id: string): boolean {
    const child = this.children.get(id)
    const job = this.jobs.get(id)
    if (!child || !job || job.status !== 'running') return false
    try {
      child.kill('SIGTERM')
      job.status = 'killed'
      setTimeout(() => {
        if (child.exitCode == null) {
          try {
            child.kill('SIGKILL')
          } catch {
            // ignore
          }
        }
      }, 2000).unref()
      return true
    } catch {
      return false
    }
  }

  /** Pending exit ids — caller should drain on each user turn. */
  drainExits(): MonitoredJob[] {
    const exited = [...this.pendingExits]
      .map(id => this.jobs.get(id))
      .filter((j): j is MonitoredJob => Boolean(j))
    this.pendingExits.clear()
    return exited
  }

  stopAll(): void {
    for (const [, child] of this.children) {
      try {
        child.kill('SIGKILL')
      } catch {
        // ignore
      }
    }
    this.children.clear()
    this.jobs.clear()
    this.pendingExits.clear()
  }
}

const monitorSchema = z.object({
  command: z
    .string()
    .min(1)
    .describe('Bash command to run as a long-lived background job.'),
  description: z
    .string()
    .min(1)
    .describe('Short label shown in any UI and in completion notifications.'),
})

const description = `Start a long-running background process whose stdout/stderr stream to a file.

Use this for "watch something and let me know when it changes" tasks:
- tail -f /var/log/app.log    — watch a log
- while true; do curl ... ; sleep 5; done   — poll an endpoint
- inotifywait -m -r ./src     — watch files

Returns a shell_id and the output file path. Read the output file at any time to inspect progress. When the process exits, you'll get a system-reminder on your next turn telling you so. Use KillShell to stop it early.`

export interface MonitorToolOptions {
  registry: MonitorRegistry
  cwd: string
}

export function createMonitorTool(options: MonitorToolOptions) {
  return tool(
    (input: z.infer<typeof monitorSchema>) => {
      const job = options.registry.spawn({
        command: input.command,
        description: input.description,
        cwd: options.cwd,
      })
      return `started Monitor job\nshell_id: ${job.id}\ndescription: ${job.description}\noutput: ${job.outputPath}\n\nRead the output file to inspect progress. KillShell to stop early. You'll get a system-reminder when the process exits.`
    },
    { name: 'Monitor', description, schema: monitorSchema },
  )
}

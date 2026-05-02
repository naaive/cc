/**
 * Cron tools — schedule a future agent invocation.
 *
 * cc's `AGENT_TRIGGERS` system lets the model say "remind me to check the
 * deploy at 14:00" and have the harness fire a follow-up agent run when
 * that time arrives. The model gets three tools:
 *
 *   - CronCreate { schedule, prompt, description? } → returns job_id
 *   - CronList                                       → list of pending jobs
 *   - CronDelete { job_id }                          → remove a job
 *
 * Schedule format: 5-field cron ("MIN HOUR DOM MON DOW") OR an ISO date
 * for one-shot fires. We keep parsing minimal — full cron semantics are
 * delegated to the host's scheduler implementation.
 *
 * The actual scheduling lives in `CronScheduler` — an in-process tickless
 * timer that fires `onTrigger(prompt)` when a job is due. Hosts running
 * across process restarts should plug in their own scheduler (database-
 * backed cron daemon, systemd timers, Kubernetes CronJob, …) by passing
 * a custom `CronStore`.
 */

import { randomUUID } from 'node:crypto'
import { tool } from 'langchain'
import { z } from 'zod/v4'
import {
  computeNextFire,
  createInMemoryCronStore,
  isRepeatingSchedule as isRepeating,
  type CronJob,
  type CronStore,
} from '../lib/cronSchedule.js'

export {
  computeNextFire,
  createInMemoryCronStore,
  type CronJob,
  type CronStore,
}

/**
 * Tickless scheduler: schedules a single timer for the next-due job, fires,
 * advances or removes that job, repeats. Hosts that want more reliability
 * (durable, across process restarts, multi-process) replace this with
 * their own implementation.
 */
export class CronScheduler {
  private timer: ReturnType<typeof setTimeout> | null = null
  constructor(
    private readonly store: CronStore,
    private readonly onTrigger: (job: CronJob) => void,
  ) {}

  /** Re-evaluate the next-due job and (re)arm the timer. */
  tick(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    const next = this.store
      .list()
      .filter((j): j is CronJob & { nextFireAt: number } => j.nextFireAt !== null)
      .sort((a, b) => a.nextFireAt - b.nextFireAt)[0]
    if (!next) return
    const delay = Math.max(0, next.nextFireAt - Date.now())
    this.timer = setTimeout(() => {
      this.fire(next.id)
      this.tick()
    }, delay)
    this.timer.unref?.()
  }

  private fire(id: string): void {
    const job = this.store.list().find(j => j.id === id)
    if (!job) return
    this.onTrigger(job)
    if (isRepeating(job.schedule)) {
      const next = computeNextFire(job.schedule, Date.now())
      this.store.update(id, { fireCount: job.fireCount + 1, nextFireAt: next })
    } else {
      this.store.update(id, { fireCount: job.fireCount + 1, nextFireAt: null })
    }
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }
}

const createSchedule = z.object({
  schedule: z
    .string()
    .min(1)
    .describe(
      'When to fire. Accepts: ISO date ("2026-05-15T14:00:00Z"), "in 30 minutes", "every 5 minutes", "@hourly", "@daily".',
    ),
  prompt: z
    .string()
    .min(1)
    .describe('The prompt the agent will receive when this fires.'),
  description: z
    .string()
    .optional()
    .describe('Short label shown in CronList output.'),
})

const deleteSchema = z.object({
  job_id: z.string().min(1).describe('Id returned by CronCreate.'),
})

const listSchema = z.object({})

const createDescription = `Schedule a future agent invocation.

The agent gets a fresh turn with \`prompt\` as the user message at the scheduled time. Use this for "remind me / check periodically" tasks.

Examples:
- "in 30 minutes" → fire once after 30m
- "every 5 minutes" → fire repeatedly until CronDelete
- "@hourly" / "@daily" → repeating
- "2026-05-15T14:00:00Z" → fire once at that ISO instant`

const listDescription = `List all pending cron jobs (id, schedule, next fire time, prompt preview).`

const deleteDescription = `Remove a scheduled cron job by id. Stops repeating jobs immediately.`

export interface CronToolsOptions {
  store: CronStore
  scheduler: CronScheduler
}

export interface CronToolsBundle {
  cronCreate: ReturnType<typeof tool>
  cronList: ReturnType<typeof tool>
  cronDelete: ReturnType<typeof tool>
}

export function createCronTools(options: CronToolsOptions): CronToolsBundle {
  const cronCreate = tool(
    (input: z.infer<typeof createSchedule>) => {
      const next = computeNextFire(input.schedule)
      if (next === null) {
        return `failed to parse schedule "${input.schedule}". Try ISO date, "in N units", "every N units", or "@hourly"/"@daily".`
      }
      const job: CronJob = {
        id: `cron_${randomUUID().slice(0, 8)}`,
        schedule: input.schedule,
        prompt: input.prompt,
        ...(input.description !== undefined ? { description: input.description } : {}),
        createdAt: Date.now(),
        nextFireAt: next,
        fireCount: 0,
      }
      options.store.add(job)
      options.scheduler.tick()
      return `scheduled job ${job.id}\nnext fire: ${new Date(next).toISOString()}\nrepeating: ${isRepeating(input.schedule)}`
    },
    {
      name: 'CronCreate',
      description: createDescription,
      schema: createSchedule,
    },
  )

  const cronList = tool(
    () => {
      const jobs = options.store.list()
      if (jobs.length === 0) return '(no scheduled jobs)'
      return jobs
        .map(j => {
          const next =
            j.nextFireAt !== null
              ? new Date(j.nextFireAt).toISOString()
              : 'never (one-shot, fired)'
          const desc = j.description ? ` — ${j.description}` : ''
          return `${j.id}${desc}\n  schedule: ${j.schedule}\n  next: ${next}\n  fired: ${j.fireCount}\n  prompt: ${j.prompt.slice(0, 80)}${j.prompt.length > 80 ? '…' : ''}`
        })
        .join('\n\n')
    },
    { name: 'CronList', description: listDescription, schema: listSchema },
  )

  const cronDelete = tool(
    (input: z.infer<typeof deleteSchema>) => {
      const ok = options.store.remove(input.job_id)
      options.scheduler.tick()
      return ok ? `deleted ${input.job_id}` : `unknown job_id: ${input.job_id}`
    },
    { name: 'CronDelete', description: deleteDescription, schema: deleteSchema },
  )

  return { cronCreate, cronList, cronDelete }
}

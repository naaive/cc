/**
 * Cron schedule parser + in-memory store.
 *
 * Pure (no langchain) so the parsing rules can be unit-tested in
 * sandboxes that don't install the lib. The langchain-side wrapper that
 * exposes the actual `CronCreate` / `CronList` / `CronDelete` tools
 * lives in `../tools/cron.ts`.
 */

export interface CronJob {
  id: string
  schedule: string
  prompt: string
  description?: string
  createdAt: number
  /** Next fire time in ms. null when the job has fired and won't repeat. */
  nextFireAt: number | null
  /** Number of times this job has fired. */
  fireCount: number
}

export interface CronStore {
  list(): CronJob[]
  add(job: CronJob): void
  remove(id: string): boolean
  update(id: string, patch: Partial<CronJob>): void
}

export function createInMemoryCronStore(): CronStore {
  const jobs = new Map<string, CronJob>()
  return {
    list: () => [...jobs.values()],
    add: job => {
      jobs.set(job.id, job)
    },
    remove: id => jobs.delete(id),
    update: (id, patch) => {
      const existing = jobs.get(id)
      if (existing) jobs.set(id, { ...existing, ...patch })
    },
  }
}

/**
 * Compute the next fire time for `schedule` after `from`.
 *
 * Accepts:
 *   - ISO date string ("2026-05-15T14:00:00Z") → fires once
 *   - "in N {seconds|minutes|hours|days}"      → fires once relative to from
 *   - "every N {minutes|hours|days}"           → repeats forever
 *   - "@daily" / "@hourly"                     → repeats forever
 *
 * Full 5-field cron syntax is intentionally NOT supported here — that's
 * the kind of footgun the model usually gets wrong. Hosts that want the
 * full thing can wrap a real cron parser into their own scheduler.
 */
export function computeNextFire(
  schedule: string,
  from = Date.now(),
): number | null {
  const trimmed = schedule.trim()
  const iso = Date.parse(trimmed)
  if (!Number.isNaN(iso)) return iso > from ? iso : null

  const inMatch = trimmed.match(/^in\s+(\d+)\s+(seconds?|minutes?|hours?|days?)$/i)
  if (inMatch) {
    const n = Number(inMatch[1])
    const ms = unitMs(inMatch[2]!.toLowerCase())
    return from + n * ms
  }

  if (trimmed.toLowerCase() === '@hourly') return from + unitMs('hours')
  if (trimmed.toLowerCase() === '@daily') return from + unitMs('days')
  const everyMatch = trimmed.match(/^every\s+(\d+)\s+(minutes?|hours?|days?)$/i)
  if (everyMatch) {
    const n = Number(everyMatch[1])
    return from + n * unitMs(everyMatch[2]!.toLowerCase())
  }
  return null
}

export function isRepeatingSchedule(schedule: string): boolean {
  const t = schedule.trim().toLowerCase()
  return t.startsWith('every ') || t === '@hourly' || t === '@daily'
}

function unitMs(unit: string): number {
  if (unit.startsWith('second')) return 1000
  if (unit.startsWith('minute')) return 60_000
  if (unit.startsWith('hour')) return 3_600_000
  if (unit.startsWith('day')) return 86_400_000
  return 0
}

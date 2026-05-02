import { describe, expect, test } from 'bun:test'
import {
  computeNextFire,
  createInMemoryCronStore,
} from '../lib/cronSchedule.js'

describe('computeNextFire', () => {
  const NOW = Date.parse('2026-05-02T10:00:00Z')

  test('parses ISO dates in the future', () => {
    const at = Date.parse('2026-05-15T14:00:00Z')
    expect(computeNextFire('2026-05-15T14:00:00Z', NOW)).toBe(at)
  })

  test('returns null for ISO dates in the past', () => {
    expect(computeNextFire('2020-01-01T00:00:00Z', NOW)).toBeNull()
  })

  test('"in N units" returns NOW + delta', () => {
    expect(computeNextFire('in 30 minutes', NOW)).toBe(NOW + 30 * 60_000)
    expect(computeNextFire('in 2 hours', NOW)).toBe(NOW + 2 * 3_600_000)
    expect(computeNextFire('in 1 day', NOW)).toBe(NOW + 86_400_000)
    expect(computeNextFire('in 5 seconds', NOW)).toBe(NOW + 5_000)
  })

  test('"every N units" returns NOW + delta (caller will re-call after fire)', () => {
    expect(computeNextFire('every 5 minutes', NOW)).toBe(NOW + 5 * 60_000)
    expect(computeNextFire('every 1 hour', NOW)).toBe(NOW + 3_600_000)
  })

  test('@hourly / @daily', () => {
    expect(computeNextFire('@hourly', NOW)).toBe(NOW + 3_600_000)
    expect(computeNextFire('@daily', NOW)).toBe(NOW + 86_400_000)
  })

  test('returns null for malformed input', () => {
    expect(computeNextFire('garbage', NOW)).toBeNull()
    expect(computeNextFire('every banana', NOW)).toBeNull()
    expect(computeNextFire('', NOW)).toBeNull()
  })

  test('case-insensitive on units and modifiers', () => {
    expect(computeNextFire('IN 5 MINUTES', NOW)).toBe(NOW + 5 * 60_000)
    expect(computeNextFire('Every 1 Hour', NOW)).toBe(NOW + 3_600_000)
  })
})

describe('createInMemoryCronStore', () => {
  const sample = {
    id: 'cron_a',
    schedule: '@hourly',
    prompt: 'check deploy',
    createdAt: 0,
    nextFireAt: 1000,
    fireCount: 0,
  }

  test('add / list / remove round-trip', () => {
    const s = createInMemoryCronStore()
    expect(s.list()).toEqual([])
    s.add(sample)
    expect(s.list()).toEqual([sample])
    expect(s.remove('cron_a')).toBe(true)
    expect(s.list()).toEqual([])
    expect(s.remove('cron_a')).toBe(false)
  })

  test('update merges patches', () => {
    const s = createInMemoryCronStore()
    s.add(sample)
    s.update('cron_a', { fireCount: 3, nextFireAt: 5000 })
    const out = s.list()[0]!
    expect(out.fireCount).toBe(3)
    expect(out.nextFireAt).toBe(5000)
    expect(out.schedule).toBe('@hourly') // untouched
  })

  test('update on missing id is a no-op', () => {
    const s = createInMemoryCronStore()
    s.update('nope', { fireCount: 1 })
    expect(s.list()).toEqual([])
  })
})

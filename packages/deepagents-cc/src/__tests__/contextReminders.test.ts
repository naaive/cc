/**
 * Reminders that touch the FileStateCache + persistent shell.
 *
 * fileStateContext + cwdDrift are pure (just closures), so we test them
 * with stand-in cache / cwd providers — no langchain runtime needed.
 */

import { describe, expect, test } from 'bun:test'
import { ccReminders, type ReminderContext } from '../middleware/reminders.js'
import { makeFileStateCache } from '../tools/fsUtils.js'

function ctx(overrides: Partial<ReminderContext> = {}): ReminderContext {
  return {
    state: {},
    turn: 1,
    lastUserText: '',
    todos: [],
    permissionMode: 'default',
    ...overrides,
  }
}

describe('ccReminders.fileStateContext', () => {
  test('returns null for an empty cache', () => {
    const c = makeFileStateCache()
    const r = ccReminders.fileStateContext(c)
    expect(r.shouldFire(ctx())).toBeFalsy()
  })

  test('lists every cached file with mtime', () => {
    const c = makeFileStateCache()
    c.set('/repo/a.ts', 1_700_000_000_000)
    c.set('/repo/b.ts', 1_700_000_000_000)
    const r = ccReminders.fileStateContext(c)
    const out = r.shouldFire(ctx())!
    expect(out).toContain('/repo/a.ts')
    expect(out).toContain('/repo/b.ts')
    expect(out).toContain('mtime')
    expect(out).toContain('Read this session')
  })

  test('only re-fires when the cache changed', () => {
    const c = makeFileStateCache()
    c.set('/a', 1)
    const r = ccReminders.fileStateContext(c)
    expect(r.shouldFire(ctx({ turn: 1 }))).toBeTruthy()
    expect(r.shouldFire(ctx({ turn: 2 }))).toBeFalsy()
    c.set('/b', 2)
    expect(r.shouldFire(ctx({ turn: 3 }))).toBeTruthy()
  })

  test('caps the listing', () => {
    const c = makeFileStateCache()
    for (let i = 0; i < 50; i++) c.set(`/f${i}.ts`, i)
    const r = ccReminders.fileStateContext(c, 5)
    const out = r.shouldFire(ctx())!
    const lines = out.split('\n').filter(l => l.startsWith('  - '))
    expect(lines.length).toBe(5)
    expect(out).toContain('45 more')
  })
})

describe('ccReminders.cwdDrift', () => {
  test('does nothing while live cwd matches baseline', () => {
    const r = ccReminders.cwdDrift(() => '/repo', '/repo')
    expect(r.shouldFire(ctx())).toBeFalsy()
  })

  test('fires once when cwd diverges', () => {
    let live = '/repo'
    const r = ccReminders.cwdDrift(() => live, '/repo')
    expect(r.shouldFire(ctx())).toBeFalsy()
    live = '/repo/sub'
    const out = r.shouldFire(ctx())
    expect(out).toContain('drifted')
    expect(out).toContain('/repo/sub')
    expect(out).toContain('cd /repo')
  })

  test('does not re-fire while cwd stays at the same drifted location', () => {
    let live = '/repo/sub'
    const r = ccReminders.cwdDrift(() => live, '/repo')
    expect(r.shouldFire(ctx({ turn: 1 }))).toBeTruthy()
    expect(r.shouldFire(ctx({ turn: 2 }))).toBeFalsy()
  })

  test('fires again after a new drift target', () => {
    let live = '/repo/sub'
    const r = ccReminders.cwdDrift(() => live, '/repo')
    r.shouldFire(ctx({ turn: 1 }))
    live = '/repo/other'
    expect(r.shouldFire(ctx({ turn: 2 }))).toBeTruthy()
  })
})

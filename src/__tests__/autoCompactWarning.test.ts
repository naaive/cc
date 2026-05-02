import { describe, expect, test } from 'bun:test'
import {
  ccReminders,
  createReminderStore,
  type ReminderContext,
} from '../middleware/reminders.js'

function ctx(overrides: Partial<ReminderContext> = {}): ReminderContext {
  return {
    store: createReminderStore({}, 'test'),
    turn: 1,
    lastUserText: '',
    todos: [],
    permissionMode: 'default',
    ...overrides,
  }
}

describe('ccReminders.autoCompactWarning', () => {
  test('does nothing while well under the warn threshold', () => {
    const r = ccReminders.autoCompactWarning(() => 10_000, 50_000, 80_000)
    expect(r.shouldFire(ctx())).toBeFalsy()
  })

  test('fires once when crossing warn but still under trigger', () => {
    const r = ccReminders.autoCompactWarning(() => 60_000, 50_000, 80_000)
    const first = r.shouldFire(ctx())
    expect(first).toBeTruthy()
    expect(first).toContain('60K tokens')
    expect(first).toContain('80K')
    // Once warned, doesn't re-fire while still in the warn zone.
    expect(r.shouldFire(ctx({ turn: 2 }))).toBeFalsy()
  })

  test('does not fire once we are at or above the trigger', () => {
    const r = ccReminders.autoCompactWarning(() => 80_000, 50_000, 80_000)
    expect(r.shouldFire(ctx())).toBeFalsy()
  })

  test('rearms after dropping back under the warn threshold', () => {
    let tokens = 60_000
    const r = ccReminders.autoCompactWarning(() => tokens, 50_000, 80_000)
    expect(r.shouldFire(ctx())).toBeTruthy()
    expect(r.shouldFire(ctx({ turn: 2 }))).toBeFalsy()
    tokens = 30_000 // post-compaction
    expect(r.shouldFire(ctx({ turn: 3 }))).toBeFalsy()
    tokens = 60_000 // grew again
    expect(r.shouldFire(ctx({ turn: 4 }))).toBeTruthy()
  })
})

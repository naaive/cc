import { describe, expect, test } from 'bun:test'
import { ccReminders, type ReminderContext } from '../middleware/reminders.js'

function makeCtx(overrides: Partial<ReminderContext> = {}): ReminderContext {
  return {
    state: {},
    turn: 1,
    lastUserText: 'hello',
    todos: [],
    permissionMode: 'default',
    ...overrides,
  }
}

describe('ccReminders.todoState', () => {
  const r = ccReminders.todoState()

  test('returns null when there are no todos', () => {
    expect(r.shouldFire(makeCtx())).toBeFalsy()
  })

  test('formats todos with status markers', () => {
    const out = r.shouldFire(
      makeCtx({
        todos: [
          { content: 'Run tests', activeForm: 'Running tests', status: 'in_progress' },
          { content: 'Build', activeForm: 'Building', status: 'pending' },
          { content: 'Deploy', activeForm: 'Deploying', status: 'completed' },
        ],
      }),
    )!
    expect(out).toContain('1. [~] Running tests')
    expect(out).toContain('2. [ ] Build')
    expect(out).toContain('3. [x] Deploy')
    expect(out).toContain('TodoWrite')
  })
})

describe('ccReminders.todoStaleNudge', () => {
  test('fires the first time when no todos exist', () => {
    const r = ccReminders.todoStaleNudge(6)
    const ctx = makeCtx({ turn: 7 })
    const out = r.shouldFire(ctx)
    expect(out).toBeTruthy()
    expect(out).toContain('TodoWrite')
  })

  test('does not fire again within the throttle window', () => {
    const r = ccReminders.todoStaleNudge(6)
    const ctx = makeCtx({ turn: 7 })
    expect(r.shouldFire(ctx)).toBeTruthy()
    // Same state object, two turns later — still inside the 6-turn window.
    expect(r.shouldFire({ ...ctx, turn: 9 })).toBeFalsy()
  })

  test('does not fire when there are todos already', () => {
    const r = ccReminders.todoStaleNudge(1)
    expect(
      r.shouldFire(
        makeCtx({
          turn: 100,
          todos: [{ content: 'X', activeForm: 'Xing', status: 'pending' }],
        }),
      ),
    ).toBeFalsy()
  })
})

describe('ccReminders.planModeActive', () => {
  const r = ccReminders.planModeActive()

  test('fires when permissionMode is "plan"', () => {
    const out = r.shouldFire(makeCtx({ permissionMode: 'plan' }))
    expect(out).toContain('Plan mode is active')
    expect(out).toContain('ExitPlanMode')
  })

  test('does not fire in other modes', () => {
    expect(r.shouldFire(makeCtx({ permissionMode: 'default' }))).toBeFalsy()
    expect(r.shouldFire(makeCtx({ permissionMode: 'acceptEdits' }))).toBeFalsy()
    expect(r.shouldFire(makeCtx({ permissionMode: 'bypassPermissions' }))).toBeFalsy()
  })
})

describe('ccReminders.custom', () => {
  test('fires every turn when everyN=1', () => {
    const r = ccReminders.custom('x', 'message', 1)
    const ctx = makeCtx()
    expect(r.shouldFire(ctx)).toBe('message')
    expect(r.shouldFire({ ...ctx, turn: 2 })).toBe('message')
  })

  test('throttles to everyN turns', () => {
    const r = ccReminders.custom('x', 'message', 3)
    const ctx = makeCtx()
    expect(r.shouldFire(ctx)).toBe('message')
    expect(r.shouldFire({ ...ctx, turn: 2 })).toBeFalsy()
    expect(r.shouldFire({ ...ctx, turn: 4 })).toBe('message')
  })
})

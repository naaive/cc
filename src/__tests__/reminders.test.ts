import { describe, expect, test } from 'bun:test'
import {
  ccReminders,
  createReminderStore,
  type ReminderContext,
} from '../middleware/reminders.js'

function makeCtx(overrides: Partial<ReminderContext> & { stateBag?: Record<string, unknown>; name?: string } = {}): ReminderContext {
  const { stateBag, name, ...rest } = overrides
  return {
    store: createReminderStore(stateBag ?? {}, name ?? 'test'),
    turn: 1,
    lastUserText: 'hello',
    todos: [],
    permissionMode: 'default',
    ...rest,
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
    const out = r.shouldFire(makeCtx({ turn: 7 }))
    expect(out).toBeTruthy()
    expect(out).toContain('TodoWrite')
  })

  test('does not fire again within the throttle window', () => {
    const r = ccReminders.todoStaleNudge(6)
    const bag: Record<string, unknown> = {}
    expect(
      r.shouldFire(makeCtx({ turn: 7, stateBag: bag, name: r.name })),
    ).toBeTruthy()
    // Same store, two turns later — still inside the 6-turn window.
    expect(
      r.shouldFire(makeCtx({ turn: 9, stateBag: bag, name: r.name })),
    ).toBeFalsy()
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
    const bag: Record<string, unknown> = {}
    expect(r.shouldFire(makeCtx({ stateBag: bag, name: r.name }))).toBe('message')
    expect(r.shouldFire(makeCtx({ turn: 2, stateBag: bag, name: r.name }))).toBe('message')
  })

  test('throttles to everyN turns', () => {
    const r = ccReminders.custom('x', 'message', 3)
    const bag: Record<string, unknown> = {}
    expect(r.shouldFire(makeCtx({ stateBag: bag, name: r.name }))).toBe('message')
    expect(r.shouldFire(makeCtx({ turn: 2, stateBag: bag, name: r.name }))).toBeFalsy()
    expect(r.shouldFire(makeCtx({ turn: 4, stateBag: bag, name: r.name }))).toBe('message')
  })
})

describe('createReminderStore — namespace isolation', () => {
  test('two reminders with different names cannot collide on the same key', () => {
    const state: Record<string, unknown> = {}
    const a = createReminderStore(state, 'reminder-a')
    const b = createReminderStore(state, 'reminder-b')
    a.set('lastTurn', 5)
    b.set('lastTurn', 12)
    expect(a.get<number>('lastTurn')).toBe(5)
    expect(b.get<number>('lastTurn')).toBe(12)
  })

  test('two stores with the same name share state', () => {
    const state: Record<string, unknown> = {}
    const a = createReminderStore(state, 'shared')
    const b = createReminderStore(state, 'shared')
    a.set('k', 'v')
    expect(b.get<string>('k')).toBe('v')
  })
})

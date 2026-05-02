/**
 * PermissionContext — read-side companion to evaluatePermission. The seam
 * tools and reminders use to ask "what would the gate say?" without
 * importing the middleware.
 */

import { describe, expect, test } from 'bun:test'
import { createPermissionContext, type PermissionMode } from '../permission.js'

describe('createPermissionContext', () => {
  test('check() reflects live mode', () => {
    let mode: PermissionMode = 'default'
    const ctx = createPermissionContext({ getMode: () => mode })
    expect(ctx.check('Bash', { command: 'ls' }).allowed).toBe(true)
    mode = 'plan'
    expect(ctx.check('Bash', { command: 'ls' }).allowed).toBe(false)
    mode = 'bypassPermissions'
    expect(ctx.check('Bash', { command: 'ls' }).allowed).toBe(true)
  })

  test('rules() returns the live snapshot', () => {
    let rules = [{ tool: 'Bash' as const, mode: 'deny' as const, reason: 'X' }]
    const ctx = createPermissionContext({
      getMode: () => 'default',
      getRules: () => rules,
    })
    expect(ctx.rules().length).toBe(1)
    rules = []
    expect(ctx.rules().length).toBe(0)
  })

  test('extraReadOnly grants plan-mode access to host-supplied tools', () => {
    const ctx = createPermissionContext({
      getMode: () => 'plan',
      extraReadOnly: new Set(['MyCustomTool']),
    })
    // MyCustomTool is unknown to classifyTool, but extraReadOnly marks it read-only.
    expect(ctx.check('MyCustomTool', {}).allowed).toBe(true)
    // Unknown writeable tool stays blocked under plan mode.
    expect(ctx.check('UnknownWriter', {}).allowed).toBe(false)
  })

  test('rule deny fires even under bypassPermissions', () => {
    const ctx = createPermissionContext({
      getMode: () => 'bypassPermissions',
      getRules: () => [
        { tool: 'Bash', match: { command: 'rm -rf*' }, mode: 'deny', reason: 'destructive' },
      ],
    })
    const decision = ctx.check('Bash', { command: 'rm -rf /' })
    expect(decision.allowed).toBe(false)
    expect(decision.reason).toBe('destructive')
  })
})

import { describe, expect, test } from 'bun:test'
import {
  classifyTool,
  decide,
  PERMISSION_MODES,
  READ_TOOL_NAMES,
  WRITE_TOOL_NAMES,
} from '../permissionMode.js'

describe('classifyTool', () => {
  test('marks deepagents writes as write', () => {
    expect(classifyTool('write_file')).toBe('write')
    expect(classifyTool('edit_file')).toBe('write')
  })

  test('marks bash and exit_plan_mode as write', () => {
    expect(classifyTool('bash')).toBe('write')
    expect(classifyTool('exit_plan_mode')).toBe('write')
  })

  test('marks read tools as read', () => {
    expect(classifyTool('read_file')).toBe('read')
    expect(classifyTool('grep')).toBe('read')
    expect(classifyTool('web_fetch')).toBe('read')
    expect(classifyTool('enter_plan_mode')).toBe('read')
  })

  test('unknown tools are unknown', () => {
    expect(classifyTool('totally_custom')).toBe('unknown')
  })
})

describe('decide', () => {
  test('default mode allows everything', () => {
    expect(decide('default', 'bash').allowed).toBe(true)
    expect(decide('default', 'write_file').allowed).toBe(true)
    expect(decide('default', 'totally_custom').allowed).toBe(true)
  })

  test('plan mode blocks writes including unknown tools', () => {
    expect(decide('plan', 'write_file').allowed).toBe(false)
    expect(decide('plan', 'bash').allowed).toBe(false)
    expect(decide('plan', 'unknown_tool').allowed).toBe(false)
  })

  test('plan mode allows reads and explicit read-only overrides', () => {
    expect(decide('plan', 'read_file').allowed).toBe(true)
    expect(decide('plan', 'grep').allowed).toBe(true)
    expect(
      decide('plan', 'my_safe_tool', new Set(['my_safe_tool'])).allowed,
    ).toBe(true)
  })

  test('bypassPermissions allows everything', () => {
    for (const tool of ['write_file', 'bash', 'unknown']) {
      expect(decide('bypassPermissions', tool).allowed).toBe(true)
    }
  })

  test('PERMISSION_MODES enumerates all four modes', () => {
    expect([...PERMISSION_MODES]).toEqual([
      'default',
      'acceptEdits',
      'plan',
      'bypassPermissions',
    ])
  })

  test('classifier sets stay disjoint', () => {
    for (const w of WRITE_TOOL_NAMES) {
      expect(READ_TOOL_NAMES.has(w)).toBe(false)
    }
  })
})

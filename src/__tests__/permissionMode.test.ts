import { describe, expect, test } from 'bun:test'
import {
  classifyTool,
  decide,
  PERMISSION_MODES,
  READ_TOOL_NAMES,
  WRITE_TOOL_NAMES,
} from '../permissionMode.js'

describe('classifyTool (PascalCase names)', () => {
  test('marks Write/Edit/Bash/NotebookEdit/ExitPlanMode/KillShell as write', () => {
    expect(classifyTool('Write')).toBe('write')
    expect(classifyTool('Edit')).toBe('write')
    expect(classifyTool('Bash')).toBe('write')
    expect(classifyTool('NotebookEdit')).toBe('write')
    expect(classifyTool('ExitPlanMode')).toBe('write')
    expect(classifyTool('KillShell')).toBe('write')
  })

  test('marks read tools as read', () => {
    expect(classifyTool('Read')).toBe('read')
    expect(classifyTool('Glob')).toBe('read')
    expect(classifyTool('Grep')).toBe('read')
    expect(classifyTool('WebFetch')).toBe('read')
    expect(classifyTool('WebSearch')).toBe('read')
    expect(classifyTool('AskUserQuestion')).toBe('read')
    expect(classifyTool('TodoWrite')).toBe('read') // metadata only
    expect(classifyTool('BashOutput')).toBe('read')
    expect(classifyTool('Agent')).toBe('read')
  })

  test('unknown tools are unknown', () => {
    expect(classifyTool('totally_custom')).toBe('unknown')
    // legacy snake_case names are no longer recognized
    expect(classifyTool('write_file')).toBe('unknown')
    expect(classifyTool('read_file')).toBe('unknown')
  })
})

describe('decide', () => {
  test('default mode allows everything', () => {
    expect(decide('default', 'Bash').allowed).toBe(true)
    expect(decide('default', 'Write').allowed).toBe(true)
    expect(decide('default', 'totally_custom').allowed).toBe(true)
  })

  test('plan mode blocks writes including unknown tools', () => {
    expect(decide('plan', 'Write').allowed).toBe(false)
    expect(decide('plan', 'Bash').allowed).toBe(false)
    expect(decide('plan', 'Edit').allowed).toBe(false)
    expect(decide('plan', 'NotebookEdit').allowed).toBe(false)
    expect(decide('plan', 'unknown_tool').allowed).toBe(false)
  })

  test('plan mode allows reads and explicit read-only overrides', () => {
    expect(decide('plan', 'Read').allowed).toBe(true)
    expect(decide('plan', 'Grep').allowed).toBe(true)
    expect(decide('plan', 'Glob').allowed).toBe(true)
    expect(decide('plan', 'AskUserQuestion').allowed).toBe(true)
    expect(decide('plan', 'TodoWrite').allowed).toBe(true)
    expect(
      decide('plan', 'my_safe_tool', new Set(['my_safe_tool'])).allowed,
    ).toBe(true)
  })

  test('plan-mode denial mentions ExitPlanMode', () => {
    const r = decide('plan', 'Write')
    expect(r.allowed).toBe(false)
    expect(r.reason).toContain('ExitPlanMode')
  })

  test('bypassPermissions allows everything', () => {
    for (const tool of ['Write', 'Bash', 'NotebookEdit', 'unknown']) {
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

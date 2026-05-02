import { describe, expect, test } from 'bun:test'
import {
  ALL_TOOL_NAMES,
  READ_ONLY_TOOL_SET,
  WRITE_TOOL_SET,
  TOOL_DESCRIPTIONS,
  TOOL_NAMES,
} from '../tools/toolNames.js'

describe('tool name registry', () => {
  test('all canonical tools are present', () => {
    const expected = [
      'Bash',
      'BashOutput',
      'KillShell',
      'Read',
      'Write',
      'Edit',
      'Glob',
      'Grep',
      'WebFetch',
      'WebSearch',
      'TodoWrite',
      'Agent',
      'AskUserQuestion',
      'ExitPlanMode',
      'NotebookEdit',
    ] as const
    for (const name of expected) {
      expect(ALL_TOOL_NAMES).toContain(name)
    }
  })

  test('TOOL_NAMES values match their keys (PascalCase canonical)', () => {
    for (const [k, v] of Object.entries(TOOL_NAMES)) {
      expect(v as string).toBe(k)
    }
  })

  test('every name has a non-empty description', () => {
    for (const name of ALL_TOOL_NAMES) {
      expect(TOOL_DESCRIPTIONS[name].length).toBeGreaterThan(20)
    }
  })

  test('read-only / write classifications are disjoint', () => {
    for (const w of WRITE_TOOL_SET) {
      expect(READ_ONLY_TOOL_SET.has(w)).toBe(false)
    }
  })

  test('every tool is classified one way or the other', () => {
    for (const name of ALL_TOOL_NAMES) {
      const writes = WRITE_TOOL_SET.has(name)
      const reads = READ_ONLY_TOOL_SET.has(name)
      expect(writes !== reads).toBe(true) // exclusive-or: exactly one
    }
  })

  test('Read description references cat -n format', () => {
    expect(TOOL_DESCRIPTIONS.Read).toContain('cat -n')
    expect(TOOL_DESCRIPTIONS.Read).toContain('absolute path')
  })

  test('Edit description requires read-before-edit', () => {
    expect(TOOL_DESCRIPTIONS.Edit).toContain(
      'You must use your `Read` tool at least once',
    )
    expect(TOOL_DESCRIPTIONS.Edit).toContain('old_string')
    expect(TOOL_DESCRIPTIONS.Edit).toContain('replace_all')
  })

  test('Bash description steers away from cat/sed/awk/echo', () => {
    expect(TOOL_DESCRIPTIONS.Bash).toContain('cat')
    expect(TOOL_DESCRIPTIONS.Bash).toContain('sed')
    expect(TOOL_DESCRIPTIONS.Bash).toContain('awk')
    expect(TOOL_DESCRIPTIONS.Bash).toContain('Use Read')
  })

  test('Grep description mentions ripgrep and output_mode', () => {
    expect(TOOL_DESCRIPTIONS.Grep).toContain('ripgrep')
    expect(TOOL_DESCRIPTIONS.Grep).toContain('files_with_matches')
  })

  test('TodoWrite description spells out the in_progress invariant', () => {
    expect(TOOL_DESCRIPTIONS.TodoWrite).toContain('ONE task at a time')
    expect(TOOL_DESCRIPTIONS.TodoWrite).toContain('activeForm')
  })
})

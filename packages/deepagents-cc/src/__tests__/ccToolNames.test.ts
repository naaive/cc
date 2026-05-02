import { describe, expect, test } from 'bun:test'
import {
  ALL_CC_TOOL_NAMES,
  CC_READ_ONLY_TOOLS,
  CC_WRITE_TOOLS,
  TOOL_DESCRIPTIONS,
  TOOL_NAMES,
} from '../tools/ccToolNames.js'

describe('cc tool name registry', () => {
  test('all canonical cc tools are present', () => {
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
    ]
    for (const name of expected) {
      expect(ALL_CC_TOOL_NAMES).toContain(name)
    }
  })

  test('TOOL_NAMES values match their keys (PascalCase canonical)', () => {
    for (const [k, v] of Object.entries(TOOL_NAMES)) {
      expect(v).toBe(k)
    }
  })

  test('every name has a non-empty description', () => {
    for (const name of ALL_CC_TOOL_NAMES) {
      expect(TOOL_DESCRIPTIONS[name].length).toBeGreaterThan(20)
    }
  })

  test('read-only / write classifications are disjoint', () => {
    for (const w of CC_WRITE_TOOLS) {
      expect(CC_READ_ONLY_TOOLS.has(w)).toBe(false)
    }
  })

  test('every tool is classified one way or the other', () => {
    for (const name of ALL_CC_TOOL_NAMES) {
      const writes = CC_WRITE_TOOLS.has(name)
      const reads = CC_READ_ONLY_TOOLS.has(name)
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

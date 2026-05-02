import { describe, expect, test } from 'bun:test'
import {
  classifyTool,
  evaluatePermission,
  PERMISSION_MODES,
  READ_TOOL_NAMES,
  WRITE_TOOL_NAMES,
  type PermissionRule,
} from '../permission.js'

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
    expect(classifyTool('TodoWrite')).toBe('read')
    expect(classifyTool('BashOutput')).toBe('read')
    expect(classifyTool('Agent')).toBe('read')
  })

  test('unknown tools are unknown', () => {
    expect(classifyTool('totally_custom')).toBe('unknown')
    expect(classifyTool('write_file')).toBe('unknown')
    expect(classifyTool('read_file')).toBe('unknown')
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

describe('evaluatePermission — mode classifier (no rules)', () => {
  test('default mode allows everything', () => {
    expect(evaluatePermission({ mode: 'default', toolName: 'Bash', args: {} }).allowed).toBe(true)
    expect(evaluatePermission({ mode: 'default', toolName: 'Write', args: {} }).allowed).toBe(true)
    expect(evaluatePermission({ mode: 'default', toolName: 'totally_custom', args: {} }).allowed).toBe(true)
  })

  test('plan mode blocks writes including unknown tools', () => {
    for (const t of ['Write', 'Bash', 'Edit', 'NotebookEdit', 'unknown_tool']) {
      expect(evaluatePermission({ mode: 'plan', toolName: t, args: {} }).allowed).toBe(false)
    }
  })

  test('plan mode allows reads and explicit read-only overrides', () => {
    for (const t of ['Read', 'Grep', 'Glob', 'AskUserQuestion', 'TodoWrite']) {
      expect(evaluatePermission({ mode: 'plan', toolName: t, args: {} }).allowed).toBe(true)
    }
    expect(
      evaluatePermission({
        mode: 'plan',
        toolName: 'my_safe_tool',
        args: {},
        extraReadOnly: new Set(['my_safe_tool']),
      }).allowed,
    ).toBe(true)
  })

  test('plan-mode denial mentions ExitPlanMode', () => {
    const r = evaluatePermission({ mode: 'plan', toolName: 'Write', args: {} })
    expect(r.allowed).toBe(false)
    expect(r.reason).toContain('ExitPlanMode')
  })

  test('bypassPermissions allows everything', () => {
    for (const tool of ['Write', 'Bash', 'NotebookEdit', 'unknown']) {
      expect(evaluatePermission({ mode: 'bypassPermissions', toolName: tool, args: {} }).allowed).toBe(true)
    }
  })
})

describe('evaluatePermission — rule layer', () => {
  test('returns allow when no rules match (mode allows)', () => {
    expect(
      evaluatePermission({ mode: 'default', toolName: 'Read', args: { file_path: '/a' }, rules: [] }).allowed,
    ).toBe(true)
    const r = evaluatePermission({
      mode: 'default',
      toolName: 'Read',
      args: { file_path: '/a' },
      rules: [{ tool: 'Bash', mode: 'deny' }],
    })
    expect(r.allowed).toBe(true)
    expect(r.matchedRule).toBeUndefined()
  })

  test('matches by tool name', () => {
    const rules: PermissionRule[] = [{ tool: 'Bash', mode: 'deny' }]
    const r = evaluatePermission({ mode: 'default', toolName: 'Bash', args: { command: 'ls' }, rules })
    expect(r.allowed).toBe(false)
    expect(r.matchedRule?.tool).toBe('Bash')
  })

  test('wildcard tool ("*") matches every tool', () => {
    const rules: PermissionRule[] = [{ tool: '*', mode: 'allow' }]
    expect(evaluatePermission({ mode: 'default', toolName: 'Bash', args: {}, rules }).allowed).toBe(true)
    expect(evaluatePermission({ mode: 'plan', toolName: 'Read', args: {}, rules }).allowed).toBe(true)
  })

  test('first matching rule wins', () => {
    const rules: PermissionRule[] = [
      { tool: 'Bash', match: { command: 'rm*' }, mode: 'deny' },
      { tool: 'Bash', mode: 'allow' },
    ]
    expect(evaluatePermission({ mode: 'default', toolName: 'Bash', args: { command: 'rm -rf' }, rules }).allowed).toBe(false)
    expect(evaluatePermission({ mode: 'default', toolName: 'Bash', args: { command: 'ls' }, rules }).allowed).toBe(true)
  })

  test('prefix glob "git status*" matches startsWith', () => {
    const rules: PermissionRule[] = [
      { tool: 'Bash', match: { command: 'git status*' }, mode: 'allow' },
    ]
    expect(evaluatePermission({ mode: 'default', toolName: 'Bash', args: { command: 'git status -sb' }, rules }).matchedRule).toBeDefined()
    expect(evaluatePermission({ mode: 'default', toolName: 'Bash', args: { command: 'git push' }, rules }).matchedRule).toBeUndefined()
  })

  test('suffix glob "*.sql" matches endsWith on file_path', () => {
    const rules: PermissionRule[] = [
      { tool: 'Edit', match: { file_path: '*.sql' }, mode: 'deny' },
    ]
    expect(
      evaluatePermission({ mode: 'default', toolName: 'Edit', args: { file_path: '/a/b.sql', old_string: 'x', new_string: 'y' }, rules }).allowed,
    ).toBe(false)
    expect(
      evaluatePermission({ mode: 'default', toolName: 'Edit', args: { file_path: '/a/b.ts', old_string: 'x', new_string: 'y' }, rules }).allowed,
    ).toBe(true)
  })

  test('** crosses dir boundaries', () => {
    const rules: PermissionRule[] = [
      { tool: 'Edit', match: { file_path: '/etc/**' }, mode: 'deny' },
    ]
    expect(evaluatePermission({ mode: 'default', toolName: 'Edit', args: { file_path: '/etc/passwd' }, rules }).allowed).toBe(false)
    expect(evaluatePermission({ mode: 'default', toolName: 'Edit', args: { file_path: '/etc/nginx/conf.d/site.conf' }, rules }).allowed).toBe(false)
    expect(evaluatePermission({ mode: 'default', toolName: 'Edit', args: { file_path: '/srv/etc' }, rules }).allowed).toBe(true)
  })

  test('array match accepts any of the patterns', () => {
    const rules: PermissionRule[] = [
      {
        tool: 'Bash',
        match: { command: ['git status*', 'git diff*', 'ls*'] },
        mode: 'allow',
      },
    ]
    expect(evaluatePermission({ mode: 'plan', toolName: 'Bash', args: { command: 'git diff' }, rules }).allowed).toBe(true)
    expect(evaluatePermission({ mode: 'plan', toolName: 'Bash', args: { command: 'ls -la' }, rules }).allowed).toBe(true)
    expect(evaluatePermission({ mode: 'plan', toolName: 'Bash', args: { command: 'rm' }, rules }).allowed).toBe(false)
  })

  test('AND across multiple match fields', () => {
    const rules: PermissionRule[] = [
      {
        tool: 'Edit',
        match: { file_path: '/repo/*.ts', old_string: 'TODO*' },
        mode: 'allow',
      },
    ]
    expect(
      evaluatePermission({ mode: 'plan', toolName: 'Edit', args: { file_path: '/repo/a.ts', old_string: 'TODO: x' }, rules }).allowed,
    ).toBe(true)
    expect(
      evaluatePermission({ mode: 'plan', toolName: 'Edit', args: { file_path: '/repo/a.ts', old_string: 'XYZ' }, rules }).allowed,
    ).toBe(false)
  })

  test('non-string actual values are compared by equality', () => {
    const rules: PermissionRule[] = [
      { tool: 'Bash', match: { run_in_background: true }, mode: 'deny' },
    ]
    expect(evaluatePermission({ mode: 'default', toolName: 'Bash', args: { command: 'x', run_in_background: true }, rules }).allowed).toBe(false)
    expect(evaluatePermission({ mode: 'default', toolName: 'Bash', args: { command: 'x' }, rules }).allowed).toBe(true)
  })

  test('rule deny overrides bypassPermissions', () => {
    const rules: PermissionRule[] = [{ tool: 'Bash', match: { command: 'rm -rf*' }, mode: 'deny' }]
    const r = evaluatePermission({ mode: 'bypassPermissions', toolName: 'Bash', args: { command: 'rm -rf /' }, rules })
    expect(r.allowed).toBe(false)
    expect(r.matchedRule).toBeDefined()
  })

  test('rule allow short-circuits plan-mode block', () => {
    const rules: PermissionRule[] = [{ tool: 'Bash', match: { command: 'git status*' }, mode: 'allow' }]
    expect(evaluatePermission({ mode: 'plan', toolName: 'Bash', args: { command: 'git status' }, rules }).allowed).toBe(true)
  })

  test('uses rule.reason when denying', () => {
    const rules: PermissionRule[] = [{ tool: 'Bash', mode: 'deny', reason: 'no shells please' }]
    const r = evaluatePermission({ mode: 'default', toolName: 'Bash', args: {}, rules })
    expect(r.reason).toBe('no shells please')
  })
})

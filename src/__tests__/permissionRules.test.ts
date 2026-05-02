import { describe, expect, test } from 'bun:test'
import { evaluateRules, type PermissionRule } from '../permissionRules.js'

describe('evaluateRules', () => {
  test('returns no decision when no rules match', () => {
    expect(evaluateRules('Read', { file_path: '/a' }, [])).toEqual({})
    expect(
      evaluateRules('Read', { file_path: '/a' }, [
        { tool: 'Bash', mode: 'deny' },
      ]),
    ).toEqual({})
  })

  test('matches by tool name', () => {
    const rules: PermissionRule[] = [{ tool: 'Bash', mode: 'deny' }]
    expect(evaluateRules('Bash', { command: 'ls' }, rules).mode).toBe('deny')
  })

  test('wildcard tool ("*") matches every tool', () => {
    const rules: PermissionRule[] = [{ tool: '*', mode: 'allow' }]
    expect(evaluateRules('Bash', {}, rules).mode).toBe('allow')
    expect(evaluateRules('Read', {}, rules).mode).toBe('allow')
  })

  test('first matching rule wins', () => {
    const rules: PermissionRule[] = [
      { tool: 'Bash', match: { command: 'rm*' }, mode: 'deny' },
      { tool: 'Bash', mode: 'allow' },
    ]
    expect(evaluateRules('Bash', { command: 'rm -rf' }, rules).mode).toBe('deny')
    expect(evaluateRules('Bash', { command: 'ls' }, rules).mode).toBe('allow')
  })

  test('prefix glob "git status*" matches startsWith', () => {
    const rules: PermissionRule[] = [
      { tool: 'Bash', match: { command: 'git status*' }, mode: 'allow' },
    ]
    expect(evaluateRules('Bash', { command: 'git status -sb' }, rules).mode).toBe('allow')
    expect(evaluateRules('Bash', { command: 'git push' }, rules).mode).toBeUndefined()
  })

  test('suffix glob "*.sql" matches endsWith on file_path', () => {
    const rules: PermissionRule[] = [
      { tool: 'Edit', match: { file_path: '*.sql' }, mode: 'deny' },
    ]
    expect(
      evaluateRules('Edit', { file_path: '/a/b.sql', old_string: 'x', new_string: 'y' }, rules).mode,
    ).toBe('deny')
    expect(
      evaluateRules('Edit', { file_path: '/a/b.ts', old_string: 'x', new_string: 'y' }, rules).mode,
    ).toBeUndefined()
  })

  test('** crosses dir boundaries', () => {
    const rules: PermissionRule[] = [
      { tool: 'Edit', match: { file_path: '/etc/**' }, mode: 'deny' },
    ]
    expect(evaluateRules('Edit', { file_path: '/etc/passwd' }, rules).mode).toBe('deny')
    expect(
      evaluateRules('Edit', { file_path: '/etc/nginx/conf.d/site.conf' }, rules).mode,
    ).toBe('deny')
    expect(evaluateRules('Edit', { file_path: '/srv/etc' }, rules).mode).toBeUndefined()
  })

  test('array match accepts any of the patterns', () => {
    const rules: PermissionRule[] = [
      {
        tool: 'Bash',
        match: { command: ['git status*', 'git diff*', 'ls*'] },
        mode: 'allow',
      },
    ]
    expect(evaluateRules('Bash', { command: 'git diff' }, rules).mode).toBe('allow')
    expect(evaluateRules('Bash', { command: 'ls -la' }, rules).mode).toBe('allow')
    expect(evaluateRules('Bash', { command: 'rm' }, rules).mode).toBeUndefined()
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
      evaluateRules('Edit', { file_path: '/repo/a.ts', old_string: 'TODO: x' }, rules).mode,
    ).toBe('allow')
    // file_path matches, old_string does not.
    expect(
      evaluateRules('Edit', { file_path: '/repo/a.ts', old_string: 'XYZ' }, rules).mode,
    ).toBeUndefined()
  })

  test('non-string actual values are compared by equality', () => {
    const rules: PermissionRule[] = [
      { tool: 'Bash', match: { run_in_background: true }, mode: 'deny' },
    ]
    expect(evaluateRules('Bash', { command: 'x', run_in_background: true }, rules).mode).toBe(
      'deny',
    )
    expect(evaluateRules('Bash', { command: 'x' }, rules).mode).toBeUndefined()
  })
})

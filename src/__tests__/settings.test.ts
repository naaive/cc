import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadSettings, mergeSettings } from '../settings.js'

describe('mergeSettings', () => {
  test('arrays are concatenated, scalars are last-wins', () => {
    const merged = mergeSettings(
      {
        model: 'claude-sonnet-4-6',
        allowedTools: ['read_file'],
        bashAllow: ['ls'],
      },
      {
        model: 'claude-opus-4-7',
        allowedTools: ['write_file'],
        permissionMode: 'plan',
      },
    )
    expect(merged.model).toBe('claude-opus-4-7')
    expect(merged.permissionMode).toBe('plan')
    expect(merged.allowedTools).toEqual(['read_file', 'write_file'])
    expect(merged.bashAllow).toEqual(['ls'])
  })

  test('hooks across events are unioned', () => {
    const merged = mergeSettings(
      { hooks: { PreToolUse: [{ command: 'echo a' }] } },
      { hooks: { PreToolUse: [{ command: 'echo b' }], Stop: [{ command: 'echo z' }] } },
    )
    expect(merged.hooks?.PreToolUse?.length).toBe(2)
    expect(merged.hooks?.Stop?.length).toBe(1)
  })

  test('env merges via spread (b wins for conflicts)', () => {
    const merged = mergeSettings(
      { env: { FOO: '1', BAR: '1' } },
      { env: { FOO: '2', BAZ: '3' } },
    )
    expect(merged.env).toEqual({ FOO: '2', BAR: '1', BAZ: '3' })
  })
})

describe('loadSettings', () => {
  let tmp: string

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-settings-'))
    // Make it look like a project root.
    fs.mkdirSync(path.join(tmp, '.git'))
    fs.mkdirSync(path.join(tmp, '.forge'))
  })

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  test('reads project settings when present', () => {
    fs.writeFileSync(
      path.join(tmp, '.forge', 'settings.json'),
      JSON.stringify({ model: 'claude-haiku-4-5', allowedTools: ['bash'] }),
    )
    const { merged, sources } = loadSettings({ cwd: tmp, userDir: path.join(tmp, 'user-dir-empty') })
    expect(merged.model).toBe('claude-haiku-4-5')
    expect(merged.allowedTools).toEqual(['bash'])
    expect(sources.some(s => s.scope === 'project')).toBe(true)
  })

  test('local settings override project settings', () => {
    fs.writeFileSync(
      path.join(tmp, '.forge', 'settings.json'),
      JSON.stringify({ model: 'claude-sonnet-4-6', permissionMode: 'default' }),
    )
    fs.writeFileSync(
      path.join(tmp, '.forge', 'settings.local.json'),
      JSON.stringify({ permissionMode: 'plan' }),
    )
    const { merged } = loadSettings({ cwd: tmp, userDir: path.join(tmp, 'user-dir-empty') })
    expect(merged.model).toBe('claude-sonnet-4-6')
    expect(merged.permissionMode).toBe('plan')
  })

  test('malformed JSON yields a warning but does not throw', () => {
    fs.writeFileSync(path.join(tmp, '.forge', 'settings.json'), '{not json')
    const { merged, warnings } = loadSettings({ cwd: tmp, userDir: path.join(tmp, 'user-dir-empty') })
    expect(merged).toEqual({})
    expect(warnings.length).toBe(1)
  })
})

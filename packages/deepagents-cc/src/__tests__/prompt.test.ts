import { describe, expect, test } from 'bun:test'
import {
  buildEnvBlock,
  buildSystemPrompt,
  CLAUDE_CODE_IDENTITY,
  CORE_BEHAVIOR,
} from '../prompt.js'

describe('buildSystemPrompt', () => {
  const env = {
    cwd: '/tmp/repo',
    platform: 'linux' as const,
    osRelease: 'Linux 6.18',
    shell: '/bin/bash',
    isGitRepo: true,
    today: '2026-05-02',
    modelId: 'claude-sonnet-4-6',
  }

  test('includes identity, core behavior, and env block by default', () => {
    const out = buildSystemPrompt({ env })
    expect(out).toContain(CLAUDE_CODE_IDENTITY)
    expect(out).toContain('# System')
    expect(out).toContain('# Tone and style')
    expect(out).toContain('Primary working directory: /tmp/repo')
    expect(out).toContain("Today's date: 2026-05-02")
  })

  test('appends user appendix at the end', () => {
    const out = buildSystemPrompt({
      env,
      appendix: 'EXTRA_NOTE_FOR_TESTS',
    })
    expect(out.endsWith('EXTRA_NOTE_FOR_TESTS')).toBe(true)
  })

  test('identity override replaces the identity block', () => {
    const out = buildSystemPrompt({
      env,
      identityOverride: 'You are a research assistant.',
    })
    expect(out).not.toContain(CLAUDE_CODE_IDENTITY)
    expect(out).toContain('You are a research assistant.')
    expect(out).toContain(CORE_BEHAVIOR.split('\n')[0])
  })

  test('claudeMd entries are rendered when present', () => {
    const out = buildSystemPrompt({
      env,
      claudeMd: [
        {
          path: '/tmp/repo/CLAUDE.md',
          content: 'Project conventions:\n- Use snake_case for filenames.',
          scope: 'project',
        },
      ],
    })
    expect(out).toContain('# Project memory')
    expect(out).toContain('snake_case')
  })
})

describe('buildEnvBlock', () => {
  test('formats every required field', () => {
    const block = buildEnvBlock({
      cwd: '/x',
      platform: 'darwin',
      osRelease: 'Darwin 24',
      shell: 'zsh',
      isGitRepo: false,
      today: '2026-01-01',
      modelId: 'claude-opus-4-7',
    })
    expect(block).toContain('Primary working directory: /x')
    expect(block).toContain('Is a git repository: false')
    expect(block).toContain('Platform: darwin')
    expect(block).toContain('Shell: zsh')
    expect(block).toContain('claude-opus-4-7')
  })
})

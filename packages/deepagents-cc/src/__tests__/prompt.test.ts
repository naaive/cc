import { describe, expect, test } from 'bun:test'
import {
  buildCacheableSystemBlocks,
  buildEnvBlock,
  buildSystemPrompt,
  CLAUDE_CODE_AGENT_SDK_IDENTITY,
  CLAUDE_CODE_IDENTITY,
  DOING_TASKS_SECTION,
  INTRO_BLOCK,
  SYSTEM_SECTION,
  TONE_SECTION,
  TOOL_USE_POLICY,
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

  test('includes the cc identity prefix', () => {
    const out = buildSystemPrompt({ env })
    expect(out).toContain(CLAUDE_CODE_IDENTITY)
  })

  test('uses the Agent SDK prefix when agentSdk=true', () => {
    const out = buildSystemPrompt({ env, agentSdk: true })
    expect(out).toContain(CLAUDE_CODE_AGENT_SDK_IDENTITY)
    expect(out).not.toContain(CLAUDE_CODE_IDENTITY + '\n')
  })

  test('contains every cc-aligned section header', () => {
    const out = buildSystemPrompt({ env })
    expect(out).toContain('# System')
    expect(out).toContain('# Doing tasks')
    expect(out).toContain('# Tone and style')
    expect(out).toContain('# Tool use policy')
    expect(out).toContain('# Executing actions with care')
    expect(out).toContain('# Environment')
  })

  test('environment block has cwd, platform, git, today, model', () => {
    const out = buildSystemPrompt({ env })
    expect(out).toContain('Primary working directory: /tmp/repo')
    expect(out).toContain('Is a git repository: true')
    expect(out).toContain('Platform: linux')
    expect(out).toContain("Today's date: 2026-05-02")
    expect(out).toContain('claude-sonnet-4-6')
  })

  test('appendix is appended at the very end', () => {
    const out = buildSystemPrompt({ env, appendix: 'EXTRA_NOTE' })
    expect(out.endsWith('EXTRA_NOTE')).toBe(true)
  })

  test('identityOverride replaces only the identity prefix', () => {
    const out = buildSystemPrompt({
      env,
      identityOverride: 'You are Foobar.',
    })
    expect(out.startsWith('You are Foobar.')).toBe(true)
    expect(out).not.toContain(CLAUDE_CODE_IDENTITY)
    expect(out).toContain(SYSTEM_SECTION)
    expect(out).toContain(DOING_TASKS_SECTION.split('\n')[0])
  })

  test('claudeMd section is rendered when entries are present', () => {
    const out = buildSystemPrompt({
      env,
      claudeMd: [
        {
          path: '/tmp/repo/CLAUDE.md',
          content: 'snake_case for filenames',
          scope: 'project',
        },
      ],
    })
    expect(out).toContain('# Project memory')
    expect(out).toContain('snake_case')
  })

  test('intro block has the cybersec + URL guidance', () => {
    const out = buildSystemPrompt({ env })
    expect(out).toContain(INTRO_BLOCK)
    expect(out).toContain('NEVER generate or guess URLs')
  })

  test('tone block forbids emoji and asks for file_path:line_number', () => {
    expect(TONE_SECTION).toContain('emojis')
    expect(TONE_SECTION).toContain('file_path:line_number')
  })

  test('tool-use policy mentions PascalCase tool names', () => {
    expect(TOOL_USE_POLICY).toContain('Bash')
    expect(TOOL_USE_POLICY).toContain('TodoWrite')
    expect(TOOL_USE_POLICY).toContain('Agent')
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

describe('buildCacheableSystemBlocks (4-breakpoint cache strategy)', () => {
  const env = {
    cwd: '/tmp/x',
    platform: 'linux' as const,
    osRelease: 'L',
    shell: 'bash',
    isGitRepo: false,
    today: '2026-05-02',
    modelId: 'claude-sonnet-4-6',
  }

  test('returns three blocks: identity+intro, behavior, env+memory', () => {
    const blocks = buildCacheableSystemBlocks({ env })
    expect(blocks.length).toBe(3)
    expect(blocks[0]!.text).toContain(CLAUDE_CODE_IDENTITY)
    expect(blocks[0]!.text).toContain('NEVER generate or guess URLs')
    expect(blocks[1]!.text).toContain('# System')
    expect(blocks[1]!.text).toContain('# Tone and style')
    expect(blocks[2]!.text).toContain('# Environment')
    expect(blocks[2]!.text).toContain('Primary working directory: /tmp/x')
  })

  test('all three are cacheable by default', () => {
    const blocks = buildCacheableSystemBlocks({ env })
    expect(blocks.every(b => b.cacheable)).toBe(true)
  })

  test('appendix lands in the third (env-tier) block', () => {
    const blocks = buildCacheableSystemBlocks({ env, appendix: 'EXTRA' })
    expect(blocks[2]!.text).toContain('EXTRA')
  })
})

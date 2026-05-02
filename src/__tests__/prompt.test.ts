import { describe, expect, test } from 'bun:test'
import {
  AGENT_IDENTITY,
  buildEnvBlock,
  DOING_TASKS_SECTION,
  EMBEDDED_AGENT_IDENTITY,
  INTRO_BLOCK,
  SYSTEM_SECTION,
  TONE_SECTION,
  TOOL_USE_POLICY,
} from '../prompt.js'
import {
  assembleSystemPrompt,
  buildCacheableSystemBlocks,
} from '../agent/systemPromptAssembly.js'

const env = {
  cwd: '/tmp/repo',
  platform: 'linux' as const,
  osRelease: 'Linux 6.18',
  shell: '/bin/bash',
  isGitRepo: true,
  today: '2026-05-02',
  modelId: 'claude-sonnet-4-6',
}

describe('assembleSystemPrompt', () => {
  test('includes the agent identity prefix', () => {
    const out = assembleSystemPrompt({ env })
    expect(out).toContain(AGENT_IDENTITY)
  })

  test('uses the embedded-agent prefix when embedded=true', () => {
    const out = assembleSystemPrompt({ env, embedded: true })
    expect(out).toContain(EMBEDDED_AGENT_IDENTITY)
    expect(out).not.toContain(AGENT_IDENTITY + '\n')
  })

  test('contains every standard section header', () => {
    const out = assembleSystemPrompt({ env })
    expect(out).toContain('# System')
    expect(out).toContain('# Doing tasks')
    expect(out).toContain('# Tone and style')
    expect(out).toContain('# Tool use policy')
    expect(out).toContain('# Executing actions with care')
    expect(out).toContain('# Environment')
  })

  test('environment block has cwd, platform, git, today, model', () => {
    const out = assembleSystemPrompt({ env })
    expect(out).toContain('Primary working directory: /tmp/repo')
    expect(out).toContain('Is a git repository: true')
    expect(out).toContain('Platform: linux')
    expect(out).toContain("Today's date: 2026-05-02")
    expect(out).toContain('claude-sonnet-4-6')
  })

  test('appendix is appended at the very end', () => {
    const out = assembleSystemPrompt({ env, systemPromptAppendix: 'EXTRA_NOTE' })
    expect(out.endsWith('EXTRA_NOTE')).toBe(true)
  })

  test('identityOverride replaces only the identity prefix', () => {
    const out = assembleSystemPrompt({
      env,
      identityOverride: 'You are Foobar.',
    })
    expect(out.startsWith('You are Foobar.')).toBe(true)
    expect(out).not.toContain(AGENT_IDENTITY)
    expect(out).toContain(SYSTEM_SECTION)
    expect(out).toContain(DOING_TASKS_SECTION.split('\n')[0])
  })

  test('projectMemory section is rendered when entries are present', () => {
    const out = assembleSystemPrompt({
      env,
      projectMemory: [
        {
          path: '/tmp/repo/AGENTS.md',
          content: 'snake_case for filenames',
          scope: 'project',
          mtimeMs: Date.now(),
        },
      ],
    })
    expect(out).toContain('# Project memory')
    expect(out).toContain('snake_case')
  })

  test('intro block has the cybersec + URL guidance', () => {
    const out = assembleSystemPrompt({ env })
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

  test('skills listing is appended after the appendix', () => {
    const out = assembleSystemPrompt({
      env,
      skills: [
        {
          name: 'demo',
          description: 'A demo skill',
          path: '/x/SKILL.md',
          source: 'project',
        },
      ],
    })
    expect(out).toContain('# Skills')
    expect(out).toContain('demo')
    expect(out).toContain('A demo skill')
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
  const env2 = {
    cwd: '/tmp/x',
    platform: 'linux' as const,
    osRelease: 'L',
    shell: 'bash',
    isGitRepo: false,
    today: '2026-05-02',
    modelId: 'claude-sonnet-4-6',
  }

  test('returns three blocks: identity+intro, behavior, env+memory', () => {
    const blocks = buildCacheableSystemBlocks({ env: env2 })
    expect(blocks.length).toBe(3)
    expect(blocks[0]!.text).toContain(AGENT_IDENTITY)
    expect(blocks[0]!.text).toContain('NEVER generate or guess URLs')
    expect(blocks[1]!.text).toContain('# System')
    expect(blocks[1]!.text).toContain('# Tone and style')
    expect(blocks[2]!.text).toContain('# Environment')
    expect(blocks[2]!.text).toContain('Primary working directory: /tmp/x')
  })

  test('all three are cacheable by default', () => {
    const blocks = buildCacheableSystemBlocks({ env: env2 })
    expect(blocks.every(b => b.cacheable)).toBe(true)
  })

  test('appendix lands in the third (env-tier) block', () => {
    const blocks = buildCacheableSystemBlocks({
      env: env2,
      systemPromptAppendix: 'EXTRA',
    })
    expect(blocks[2]!.text).toContain('EXTRA')
  })
})

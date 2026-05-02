import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { formatClaudeMd, loadClaudeMd } from '../claudemd.js'

describe('loadClaudeMd', () => {
  let tmp: string

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ccx-md-'))
  })

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  test('finds project CLAUDE.md', () => {
    fs.writeFileSync(path.join(tmp, 'CLAUDE.md'), '# project rules\nuse semicolons')
    const entries = loadClaudeMd({ cwd: tmp, ceiling: tmp })
    const project = entries.filter(e => e.scope === 'project')
    expect(project.length).toBe(1)
    expect(project[0]!.content).toContain('use semicolons')
  })

  test('falls back to AGENTS.md when CLAUDE.md is absent', () => {
    fs.writeFileSync(path.join(tmp, 'AGENTS.md'), 'agent guidance')
    const entries = loadClaudeMd({ cwd: tmp, ceiling: tmp })
    expect(entries.find(e => e.path.endsWith('AGENTS.md'))).toBeDefined()
  })

  test('walks up the dir tree and returns outermost first', () => {
    const inner = path.join(tmp, 'a', 'b')
    fs.mkdirSync(inner, { recursive: true })
    fs.writeFileSync(path.join(tmp, 'CLAUDE.md'), 'OUTER')
    fs.writeFileSync(path.join(tmp, 'a', 'CLAUDE.md'), 'MIDDLE')
    fs.writeFileSync(path.join(inner, 'CLAUDE.md'), 'INNER')
    const entries = loadClaudeMd({ cwd: inner, ceiling: tmp })
    const projectContents = entries
      .filter(e => e.scope === 'project')
      .map(e => e.content.trim())
    expect(projectContents).toEqual(['OUTER', 'MIDDLE', 'INNER'])
  })

  test('truncates files larger than maxBytes', () => {
    const big = 'x'.repeat(50)
    fs.writeFileSync(path.join(tmp, 'CLAUDE.md'), big)
    const entries = loadClaudeMd({ cwd: tmp, ceiling: tmp, maxBytes: 10 })
    expect(entries[0]!.content).toContain('[truncated')
    expect(entries[0]!.content.length).toBeLessThan(big.length)
  })
})

describe('formatClaudeMd', () => {
  test('returns empty string when there are no entries', () => {
    expect(formatClaudeMd([])).toBe('')
  })

  test('prefixes each section with a scope-aware header', () => {
    const out = formatClaudeMd([
      { path: '/p/CLAUDE.md', content: 'A', scope: 'project' },
      { path: '/u/CLAUDE.md', content: 'B', scope: 'user' },
    ])
    expect(out).toContain('# Project memory: /p/CLAUDE.md')
    expect(out).toContain('# User memory: /u/CLAUDE.md')
    expect(out).toContain('---')
  })
})

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { formatProjectMemory, loadProjectMemory } from '../memory.js'

describe('loadProjectMemory', () => {
  let tmp: string

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-memory-'))
  })

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  test('finds project AGENTS.md', () => {
    fs.writeFileSync(path.join(tmp, 'AGENTS.md'), '# project rules\nuse semicolons')
    const entries = loadProjectMemory({ cwd: tmp, ceiling: tmp })
    const project = entries.filter(e => e.scope === 'project')
    expect(project.length).toBe(1)
    expect(project[0]!.content).toContain('use semicolons')
  })

  test('returns nothing when no AGENTS.md exists', () => {
    const entries = loadProjectMemory({ cwd: tmp, ceiling: tmp })
    expect(entries.filter(e => e.scope === 'project')).toEqual([])
  })

  test('walks up the dir tree and returns outermost first', () => {
    const inner = path.join(tmp, 'a', 'b')
    fs.mkdirSync(inner, { recursive: true })
    fs.writeFileSync(path.join(tmp, 'AGENTS.md'), 'OUTER')
    fs.writeFileSync(path.join(tmp, 'a', 'AGENTS.md'), 'MIDDLE')
    fs.writeFileSync(path.join(inner, 'AGENTS.md'), 'INNER')
    const entries = loadProjectMemory({ cwd: inner, ceiling: tmp })
    const projectContents = entries
      .filter(e => e.scope === 'project')
      .map(e => e.content.trim())
    expect(projectContents).toEqual(['OUTER', 'MIDDLE', 'INNER'])
  })

  test('truncates files larger than maxBytes', () => {
    const big = 'x'.repeat(50)
    fs.writeFileSync(path.join(tmp, 'AGENTS.md'), big)
    const entries = loadProjectMemory({ cwd: tmp, ceiling: tmp, maxBytes: 10 })
    expect(entries[0]!.content).toContain('[truncated')
    expect(entries[0]!.content.length).toBeLessThan(big.length)
  })
})

describe('formatProjectMemory', () => {
  test('returns empty string when there are no entries', () => {
    expect(formatProjectMemory([])).toBe('')
  })

  test('prefixes each section with a scope-aware header', () => {
    const out = formatProjectMemory([
      { path: '/p/AGENTS.md', content: 'A', scope: 'project', mtimeMs: Date.now() },
      { path: '/u/AGENTS.md', content: 'B', scope: 'user', mtimeMs: Date.now() },
    ])
    expect(out).toContain('# Project memory: /p/AGENTS.md')
    expect(out).toContain('# User memory: /u/AGENTS.md')
    expect(out).toContain('---')
  })
})

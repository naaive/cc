import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  findSimilarFile,
  levenshtein,
  pathRecoveryHint,
  suggestPathUnderCwd,
} from '../tools/pathRecovery.js'

describe('levenshtein', () => {
  test('returns 0 for equal strings', () => {
    expect(levenshtein('foo', 'foo')).toBe(0)
  })

  test('counts single edit distances', () => {
    expect(levenshtein('foo', 'fou')).toBe(1) // substitution
    expect(levenshtein('foo', 'foox')).toBe(1) // insertion
    expect(levenshtein('foo', 'fo')).toBe(1) // deletion
  })

  test('clamps at cap+1 for early exit', () => {
    expect(levenshtein('abcdef', 'zzzzzz', 2)).toBe(3)
  })
})

describe('findSimilarFile', () => {
  let tmp: string

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ccx-pr-'))
  })

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  test('finds case-only mismatch immediately', () => {
    fs.writeFileSync(path.join(tmp, 'README.md'), '')
    expect(findSimilarFile(path.join(tmp, 'readme.md'))).toBe(
      path.join(tmp, 'README.md'),
    )
  })

  test('finds typos within distance', () => {
    fs.writeFileSync(path.join(tmp, 'config.ts'), '')
    expect(findSimilarFile(path.join(tmp, 'cofnig.ts'))).toBe(
      path.join(tmp, 'config.ts'),
    )
  })

  test('returns null when nothing close exists', () => {
    fs.writeFileSync(path.join(tmp, 'a.md'), '')
    expect(findSimilarFile(path.join(tmp, 'totally-different-name.txt'))).toBeNull()
  })
})

describe('suggestPathUnderCwd', () => {
  let tmp: string

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ccx-pr-'))
  })

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  test('finds basename matches anywhere under cwd', () => {
    fs.mkdirSync(path.join(tmp, 'a/b/c'), { recursive: true })
    fs.writeFileSync(path.join(tmp, 'a', 'b', 'c', 'target.ts'), '')
    fs.writeFileSync(path.join(tmp, 'a', 'target.ts'), '')
    const found = suggestPathUnderCwd(tmp, '/whatever/target.ts')
    expect(found.length).toBe(2)
    expect(found.every(p => p.endsWith('/target.ts'))).toBe(true)
  })

  test('skips node_modules and .git', () => {
    fs.mkdirSync(path.join(tmp, 'node_modules', 'pkg'), { recursive: true })
    fs.writeFileSync(path.join(tmp, 'node_modules', 'pkg', 'config.ts'), '')
    fs.writeFileSync(path.join(tmp, 'config.ts'), '')
    expect(suggestPathUnderCwd(tmp, '/x/config.ts')).toEqual([
      path.join(tmp, 'config.ts'),
    ])
  })

  test('caps at maxResults', () => {
    for (let i = 0; i < 5; i++) {
      fs.mkdirSync(path.join(tmp, `dir${i}`))
      fs.writeFileSync(path.join(tmp, `dir${i}`, 'a.ts'), '')
    }
    expect(suggestPathUnderCwd(tmp, '/x/a.ts', 3).length).toBe(3)
  })
})

describe('pathRecoveryHint', () => {
  let tmp: string

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ccx-pr-'))
  })

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  test('returns null when no candidates exist', () => {
    expect(pathRecoveryHint(path.join(tmp, 'nope.ts'), tmp)).toBeNull()
  })

  test('lists similar + cwd matches without duplicates', () => {
    fs.writeFileSync(path.join(tmp, 'config.ts'), '')
    const hint = pathRecoveryHint(path.join(tmp, 'cofnig.ts'), tmp)
    expect(hint).toContain('Did you mean')
    expect(hint).toContain('config.ts')
    // The Levenshtein match and the basename walk both find the same file;
    // the hint should not list it twice.
    const occurrences = hint!.split('config.ts').length - 1
    expect(occurrences).toBe(1)
  })
})

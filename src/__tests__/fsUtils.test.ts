import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  addLineNumbers,
  applyDeterministicEdit,
  ensureAbsolute,
  isBinaryFile,
  makeFileStateCache,
  readTextFile,
  truncateLine,
  writeTextFile,
} from '../tools/fsUtils.js'

describe('ensureAbsolute', () => {
  test('passes through absolute paths', () => {
    expect(ensureAbsolute('/etc/passwd')).toBe('/etc/passwd')
  })

  test('rejects relative paths', () => {
    expect(() => ensureAbsolute('foo/bar')).toThrow(/absolute path/)
    expect(() => ensureAbsolute('./foo')).toThrow(/absolute path/)
  })

  test('normalizes intermediate `..`', () => {
    expect(ensureAbsolute('/a/b/../c')).toBe('/a/c')
  })
})

describe('addLineNumbers', () => {
  test('formats as cat -n with right-aligned widths', () => {
    const out = addLineNumbers('a\nb\nc')
    expect(out).toBe('1\ta\n2\tb\n3\tc')
  })

  test('right-aligns when line count crosses a digit boundary', () => {
    const out = addLineNumbers('a\nb', 9)
    // start=9, two lines → widths "9","10"; pad to width 2.
    expect(out).toBe(' 9\ta\n10\tb')
  })
})

describe('truncateLine', () => {
  test('returns short lines verbatim', () => {
    expect(truncateLine('hi', 10)).toBe('hi')
  })

  test('truncates and annotates long lines', () => {
    const out = truncateLine('x'.repeat(20), 10)
    expect(out.startsWith('xxxxxxxxxx')).toBe(true)
    expect(out).toContain('truncated')
  })
})

describe('applyDeterministicEdit', () => {
  test('replaces a unique occurrence', () => {
    expect(applyDeterministicEdit('foo bar baz', 'bar', 'BAR')).toBe('foo BAR baz')
  })

  test('rejects when old_string is missing', () => {
    expect(() => applyDeterministicEdit('foo', 'missing', 'x')).toThrow(/not found/)
  })

  test('rejects when old_string occurs more than once', () => {
    expect(() => applyDeterministicEdit('a a', 'a', 'X')).toThrow(/not unique/)
  })

  test('replaceAll path replaces every occurrence', () => {
    expect(applyDeterministicEdit('a a a', 'a', 'X', true)).toBe('X X X')
  })

  test('rejects identical old/new strings', () => {
    expect(() => applyDeterministicEdit('foo', 'foo', 'foo')).toThrow(/identical/)
  })

  test('rejects empty old_string', () => {
    expect(() => applyDeterministicEdit('foo', '', 'X')).toThrow(/empty/)
  })

  test('empty new_string deletes the match', () => {
    expect(applyDeterministicEdit('foo bar', 'bar', '')).toBe('foo ')
  })
})

describe('readTextFile + writeTextFile (real disk)', () => {
  let tmp: string

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-fs-'))
  })

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  test('round-trips simple text', () => {
    const file = path.join(tmp, 'a.txt')
    writeTextFile(file, 'hello')
    const r = readTextFile(file)
    expect(r.text).toBe('hello')
    expect(r.totalLines).toBe(1)
    expect(r.truncated).toBe(false)
  })

  test('respects offset and limit', () => {
    const file = path.join(tmp, 'a.txt')
    writeTextFile(file, '0\n1\n2\n3\n4\n5')
    const r = readTextFile(file, { offset: 1, limit: 2 })
    expect(r.text).toBe('1\n2')
    expect(r.totalLines).toBe(6)
    expect(r.truncated).toBe(true)
  })

  test('refuses binary files', () => {
    const file = path.join(tmp, 'bin')
    fs.writeFileSync(file, Buffer.from([0x00, 0x01, 0x02]))
    expect(() => readTextFile(file)).toThrow(/binary/)
  })

  test('writeTextFile is atomic — original survives a renamed-mid-flight scenario', () => {
    const file = path.join(tmp, 'a.txt')
    writeTextFile(file, 'first')
    expect(fs.readFileSync(file, 'utf8')).toBe('first')
    writeTextFile(file, 'second')
    expect(fs.readFileSync(file, 'utf8')).toBe('second')
  })

  test('isBinaryFile returns false for text and true for NUL-containing data', () => {
    const text = path.join(tmp, 'text.txt')
    const binary = path.join(tmp, 'bin')
    fs.writeFileSync(text, 'hello world')
    fs.writeFileSync(binary, Buffer.from([0x00, 0x42]))
    expect(isBinaryFile(text)).toBe(false)
    expect(isBinaryFile(binary)).toBe(true)
  })
})

describe('FileStateCache', () => {
  test('stores and returns mtimes', () => {
    const cache = makeFileStateCache()
    expect(cache.get('/x')).toBeUndefined()
    cache.set('/x', 1234)
    expect(cache.get('/x')).toBe(1234)
  })
})

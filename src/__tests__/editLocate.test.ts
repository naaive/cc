import { describe, expect, test } from 'bun:test'
import {
  applyDeterministicEdit,
  locateAllMatches,
  makeFileStateCache,
} from '../tools/fsUtils.js'

describe('locateAllMatches', () => {
  test('finds every occurrence with line + col', () => {
    const src = 'foo\nbar foo\n  foo'
    const matches = locateAllMatches(src, 'foo', 10)
    expect(matches.map(m => m.line)).toEqual([1, 2, 3])
    expect(matches[0]!.col).toBe(1)
    expect(matches[1]!.col).toBe(5)
    expect(matches[2]!.col).toBe(3)
  })

  test('extracts the full line for context', () => {
    const src = 'first\nfoo bar\nfoo baz\n'
    const matches = locateAllMatches(src, 'foo', 10)
    expect(matches[0]!.contextLine).toBe('foo bar')
    expect(matches[1]!.contextLine).toBe('foo baz')
  })

  test('respects the cap', () => {
    const src = 'foo\nfoo\nfoo\nfoo\nfoo'
    expect(locateAllMatches(src, 'foo', 2).length).toBe(2)
  })

  test('returns empty for no matches', () => {
    expect(locateAllMatches('abc', 'z', 5)).toEqual([])
  })
})

describe('applyDeterministicEdit non-unique error', () => {
  test('reports match count + line numbers in the error message', () => {
    const src = 'a\nfoo\nbar\nfoo\nbaz\nfoo'
    expect(() => applyDeterministicEdit(src, 'foo', 'X')).toThrow(/3 matches/)
    expect(() => applyDeterministicEdit(src, 'foo', 'X')).toThrow(/line 2/)
    expect(() => applyDeterministicEdit(src, 'foo', 'X')).toThrow(/line 4/)
    expect(() => applyDeterministicEdit(src, 'foo', 'X')).toThrow(/line 6/)
  })

  test('shows the full line as context for each match', () => {
    const src = 'const x = 1\nconst y = 1\nconst z = 1'
    expect(() => applyDeterministicEdit(src, '= 1', 'Y')).toThrow(/const x = 1/)
    expect(() => applyDeterministicEdit(src, '= 1', 'Y')).toThrow(/const y = 1/)
    expect(() => applyDeterministicEdit(src, '= 1', 'Y')).toThrow(/const z = 1/)
  })

  test('caps the listing and adds "more" marker for many matches', () => {
    const src = Array.from({ length: 10 }, () => 'foo').join('\n')
    let err: Error | null = null
    try {
      applyDeterministicEdit(src, 'foo', 'X')
    } catch (e) {
      err = e as Error
    }
    expect(err).not.toBeNull()
    expect(err!.message).toContain('10 matches')
    expect(err!.message).toContain('(more)')
  })
})

describe('FileStateCache.entries / size', () => {
  test('round-trips paths and mtimes', () => {
    const c = makeFileStateCache()
    c.set('/a', 1)
    c.set('/b', 2)
    expect(c.size()).toBe(2)
    expect(new Map(c.entries())).toEqual(new Map([['/a', 1], ['/b', 2]]))
  })

  test('size starts at 0 / set updates existing', () => {
    const c = makeFileStateCache()
    expect(c.size()).toBe(0)
    c.set('/a', 1)
    c.set('/a', 2)
    expect(c.size()).toBe(1)
    expect(c.get('/a')).toBe(2)
  })
})

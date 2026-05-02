import { describe, expect, test } from 'bun:test'
import { globToRegex } from '../tools/globRegex.js'

describe('globToRegex', () => {
  test('* matches within a single segment', () => {
    const re = globToRegex('*.ts')
    expect(re.test('foo.ts')).toBe(true)
    expect(re.test('a/foo.ts')).toBe(false)
    expect(re.test('foo.tsx')).toBe(false)
  })

  test('** matches any depth', () => {
    const re = globToRegex('**/*.ts')
    expect(re.test('foo.ts')).toBe(true)
    expect(re.test('a/foo.ts')).toBe(true)
    expect(re.test('a/b/c/foo.ts')).toBe(true)
    expect(re.test('foo.tsx')).toBe(false)
  })

  test('? matches one char', () => {
    const re = globToRegex('?.md')
    expect(re.test('a.md')).toBe(true)
    expect(re.test('ab.md')).toBe(false)
  })

  test('character classes', () => {
    const re = globToRegex('[abc].txt')
    expect(re.test('a.txt')).toBe(true)
    expect(re.test('b.txt')).toBe(true)
    expect(re.test('z.txt')).toBe(false)
  })

  test('special regex chars are escaped', () => {
    const re = globToRegex('a+b.txt')
    expect(re.test('a+b.txt')).toBe(true)
    expect(re.test('aab.txt')).toBe(false)
  })

  test('exact paths still match', () => {
    const re = globToRegex('src/index.ts')
    expect(re.test('src/index.ts')).toBe(true)
    expect(re.test('src/index.tsx')).toBe(false)
  })
})

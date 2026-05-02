import { describe, expect, test } from 'bun:test'
import { defaultLargeResultSummary } from '../lib/largeResultSummary.js'

describe('defaultLargeResultSummary', () => {
  test('returns input untouched when within head+tail budget', () => {
    const text = 'x'.repeat(2000)
    expect(defaultLargeResultSummary(text)).toBe(text)
  })

  test('elides middle when oversize, preserving head and tail', () => {
    const text =
      'A'.repeat(1500) + 'M'.repeat(20_000) + 'Z'.repeat(1500)
    const summary = defaultLargeResultSummary(text)
    expect(summary).toContain('A'.repeat(1500))
    expect(summary).toContain('Z'.repeat(1500))
    expect(summary).not.toContain('M'.repeat(100))
    expect(summary).toContain('chars elided')
  })

  test('reports the number of elided chars', () => {
    const text = 'a'.repeat(5000)
    const summary = defaultLargeResultSummary(text)
    // 5000 - 1500 - 1500 = 2000 chars elided
    expect(summary).toContain('2000 chars elided')
  })
})

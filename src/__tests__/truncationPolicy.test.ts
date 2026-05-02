import { describe, expect, test } from 'bun:test'
import { createTruncationPolicy } from '../tools/truncationPolicy.js'

describe('TruncationPolicy', () => {
  const policy = createTruncationPolicy()

  test('returns input untouched when under the cap', () => {
    const r = policy.apply('Grep', 'short', 100)
    expect(r.truncated).toBe(false)
    expect(r.text).toBe('short')
  })

  test('truncates and appends a refine-query hint for Grep', () => {
    const r = policy.apply('Grep', 'x'.repeat(50), 10)
    expect(r.truncated).toBe(true)
    expect(r.text.startsWith('xxxxxxxxxx')).toBe(true)
    expect(r.text).toContain('refine')
  })

  test('truncates and appends a paging hint for Read', () => {
    const r = policy.apply('Read', 'x'.repeat(50), 10)
    expect(r.truncated).toBe(true)
    expect(r.text).toContain('offset')
  })

  test('uses the refine hint for Glob and Bash', () => {
    expect(policy.apply('Glob', 'y'.repeat(50), 10).text).toContain('refine')
    expect(policy.apply('Bash', 'y'.repeat(50), 10).text).toContain('refine')
    expect(policy.apply('BashOutput', 'y'.repeat(50), 10).text).toContain('refine')
  })

  test('falls back to a generic hint for unknown tools', () => {
    const r = policy.apply('SomethingElse', 'z'.repeat(50), 10)
    expect(r.truncated).toBe(true)
    expect(r.text).toContain('truncated')
  })
})

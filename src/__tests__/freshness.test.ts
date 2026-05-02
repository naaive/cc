import { describe, expect, test } from 'bun:test'
import { memoryFreshnessNote } from '../memory.js'

const day = 24 * 60 * 60 * 1000

describe('memoryFreshnessNote', () => {
  test('today', () => {
    const now = 1_700_000_000_000
    expect(memoryFreshnessNote(now - 60_000, now)).toBe('(snapshot from today)')
  })

  test('singular day', () => {
    const now = 1_700_000_000_000
    expect(memoryFreshnessNote(now - day - 1, now)).toBe('(snapshot from 1 day ago)')
  })

  test('plural days', () => {
    const now = 1_700_000_000_000
    expect(memoryFreshnessNote(now - 5 * day, now)).toBe('(snapshot from 5 days ago)')
  })

  test('months for >= 30 days', () => {
    const now = 1_700_000_000_000
    expect(memoryFreshnessNote(now - 30 * day, now)).toBe('(snapshot from 1 month ago)')
    expect(memoryFreshnessNote(now - 90 * day, now)).toBe('(snapshot from 3 months ago)')
  })

  test('clamped at zero for future timestamps', () => {
    const now = 1_700_000_000_000
    expect(memoryFreshnessNote(now + day, now)).toBe('(snapshot from today)')
  })
})

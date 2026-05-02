import { describe, expect, test } from 'bun:test'
import {
  buildEvictionStub,
  createInMemoryResultStore,
  DEFAULT_EVICT_BYTES,
  parseStorageUri,
  shouldEvict,
  storageUri,
  TOOLS_EXCLUDED_FROM_EVICTION,
} from '../tools/resultStore.js'

describe('createInMemoryResultStore', () => {
  test('round-trips a stored result by id', () => {
    const store = createInMemoryResultStore()
    const stored = store.put('Bash', 'big payload')
    expect(stored.id).toMatch(/^cs_[a-f0-9]+$/)
    expect(stored.toolName).toBe('Bash')
    expect(stored.size).toBe('big payload'.length)
    expect(store.get(stored.id)?.content).toBe('big payload')
  })

  test('different inserts get different ids', () => {
    const store = createInMemoryResultStore()
    const a = store.put('Bash', 'x')
    const b = store.put('Bash', 'x')
    expect(a.id).not.toBe(b.id)
  })

  test('clear empties the store', () => {
    const store = createInMemoryResultStore()
    store.put('Bash', 'x')
    expect(store.size()).toBe(1)
    store.clear()
    expect(store.size()).toBe(0)
  })
})

describe('shouldEvict', () => {
  const policy = {
    evictBytes: 1000,
    excluded: TOOLS_EXCLUDED_FROM_EVICTION,
  }

  test('evicts oversize results from non-excluded tools', () => {
    expect(shouldEvict('Agent', 5000, policy)).toBe(true)
  })

  test('does not evict small results', () => {
    expect(shouldEvict('Agent', 500, policy)).toBe(false)
  })

  test('never evicts excluded tools regardless of size', () => {
    for (const tool of TOOLS_EXCLUDED_FROM_EVICTION) {
      expect(shouldEvict(tool, 1_000_000, policy)).toBe(false)
    }
  })

  test('default eviction byte threshold is sane', () => {
    expect(DEFAULT_EVICT_BYTES).toBeGreaterThan(8_000)
    expect(DEFAULT_EVICT_BYTES).toBeLessThan(200_000)
  })
})

describe('storage URI helpers', () => {
  test('storageUri prefixes with the scheme', () => {
    expect(storageUri('abc')).toBe('ccx-store://abc')
  })

  test('parseStorageUri returns the id for scheme matches', () => {
    expect(parseStorageUri('ccx-store://abc')).toBe('abc')
  })

  test('parseStorageUri returns null for non-matches', () => {
    expect(parseStorageUri('/etc/passwd')).toBeNull()
    expect(parseStorageUri('http://example.com')).toBeNull()
  })

  test('buildEvictionStub mentions the kb size and the read path', () => {
    const stored = {
      id: 'cs_abc',
      toolName: 'Bash',
      size: 65_536,
      storedAt: Date.now(),
      content: '',
    }
    const stub = buildEvictionStub(stored)
    expect(stub).toContain('64.0KB')
    expect(stub).toContain('cs_abc')
    expect(stub).toContain('Read')
    expect(stub).toContain('ccx-store://cs_abc')
  })
})

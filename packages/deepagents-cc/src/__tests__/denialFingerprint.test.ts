import { describe, expect, test } from 'bun:test'
import {
  denialFingerprint,
  stableJson,
} from '../middleware/denialFingerprint.js'

describe('stableJson', () => {
  test('orders object keys deterministically', () => {
    expect(stableJson({ b: 2, a: 1 })).toBe('{"a":1,"b":2}')
    expect(stableJson({ a: 1, b: 2 })).toBe('{"a":1,"b":2}')
  })

  test('handles nested objects', () => {
    expect(stableJson({ a: { y: 2, x: 1 } })).toBe('{"a":{"x":1,"y":2}}')
  })

  test('handles arrays positionally', () => {
    expect(stableJson([3, 1, 2])).toBe('[3,1,2]')
  })

  test('handles primitives + null', () => {
    expect(stableJson(null)).toBe('null')
    expect(stableJson(42)).toBe('42')
    expect(stableJson('x')).toBe('"x"')
    expect(stableJson(true)).toBe('true')
  })
})

describe('denialFingerprint', () => {
  test('two equivalent calls produce identical fingerprints', () => {
    const a = denialFingerprint('Bash', { command: 'rm', timeout: 1000 })
    const b = denialFingerprint('Bash', { timeout: 1000, command: 'rm' })
    expect(a).toBe(b)
  })

  test('different tool names produce different fingerprints', () => {
    const a = denialFingerprint('Bash', { command: 'ls' })
    const b = denialFingerprint('Edit', { command: 'ls' })
    expect(a).not.toBe(b)
  })

  test('different args produce different fingerprints', () => {
    const a = denialFingerprint('Bash', { command: 'ls' })
    const b = denialFingerprint('Bash', { command: 'rm' })
    expect(a).not.toBe(b)
  })
})

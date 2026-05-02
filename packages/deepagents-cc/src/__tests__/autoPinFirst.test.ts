import { describe, expect, test } from 'bun:test'
import {
  autoPinFirstByRole,
  isMessagePinned,
} from '../middleware/compactionPure.js'

interface FakeMsg {
  content: string
  type: string
  additional_kwargs?: Record<string, unknown>
  getType(): string
}

function msg(content: string, type: string): FakeMsg {
  return {
    content,
    type,
    getType() {
      return this.type
    },
  }
}

describe('autoPinFirstByRole', () => {
  test('pins the first matching role', () => {
    const a = msg('first', 'human')
    const b = msg('second', 'human')
    const sys = msg('s', 'system')
    autoPinFirstByRole([sys, a, b], 'human')
    expect(isMessagePinned(a)).toBe(true)
    expect(isMessagePinned(b)).toBe(false)
    expect(isMessagePinned(sys)).toBe(false)
  })

  test('does nothing when no message matches', () => {
    const a = msg('a', 'ai')
    autoPinFirstByRole([a], 'human')
    expect(isMessagePinned(a)).toBe(false)
  })

  test('default role is human', () => {
    const u = msg('hi', 'human')
    autoPinFirstByRole([u])
    expect(isMessagePinned(u)).toBe(true)
  })

  test('returns the input array (mutates in place)', () => {
    const a = msg('a', 'human')
    const list = [a]
    expect(autoPinFirstByRole(list)).toBe(list)
  })
})

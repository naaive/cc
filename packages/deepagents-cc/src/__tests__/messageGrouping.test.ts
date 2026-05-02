import { describe, expect, test } from 'bun:test'
import {
  groupByApiRound,
  isMetaMessage,
  isRealHumanMessage,
  markMeta,
  recentRoundCutoff,
} from '../lib/messageUtils.js'

interface FakeMsg {
  type: string
  content: string
  id?: string
  additional_kwargs?: Record<string, unknown>
  getType(): string
}

function msg(type: string, opts: Partial<FakeMsg> = {}): FakeMsg {
  return {
    type,
    content: '',
    ...opts,
    getType() {
      return this.type
    },
  } as FakeMsg
}

describe('markMeta / isMetaMessage', () => {
  test('round-trips on plain message-shaped objects', () => {
    const m = { content: 'x' }
    expect(isMetaMessage(m)).toBe(false)
    markMeta(m)
    expect(isMetaMessage(m)).toBe(true)
  })

  test('preserves existing additional_kwargs', () => {
    const m = { content: 'x', additional_kwargs: { custom: 1 } }
    markMeta(m)
    expect(m.additional_kwargs.custom).toBe(1)
    expect((m.additional_kwargs as Record<string, unknown>).__isMeta).toBe(true)
  })
})

describe('isRealHumanMessage', () => {
  test('true for unmarked human', () => {
    expect(isRealHumanMessage(msg('human'))).toBe(true)
  })

  test('false for ai / tool / system', () => {
    expect(isRealHumanMessage(msg('ai'))).toBe(false)
    expect(isRealHumanMessage(msg('tool'))).toBe(false)
    expect(isRealHumanMessage(msg('system'))).toBe(false)
  })

  test('false for human flagged as meta', () => {
    const m = msg('human')
    markMeta(m)
    expect(isRealHumanMessage(m)).toBe(false)
  })
})

describe('groupByApiRound', () => {
  test('boundary per human turn AND per AI message (with no shared id)', () => {
    const msgs = [msg('human'), msg('ai'), msg('human'), msg('ai')]
    expect(groupByApiRound(msgs)).toEqual([0, 1, 2, 3])
  })

  test('AIMessage with same id stays in current round (streaming chunks)', () => {
    const msgs = [
      msg('human'),
      msg('ai', { id: 'r1' }),
      msg('tool'),
      msg('ai', { id: 'r1' }), // streaming continuation — same round
    ]
    expect(groupByApiRound(msgs)).toEqual([0, 1])
  })

  test('AIMessage id change starts new round (single human, multiple AI rounds)', () => {
    const msgs = [
      msg('human'),
      msg('ai', { id: 'r1' }),
      msg('tool'),
      msg('ai', { id: 'r2' }), // new id → new round even within same human turn
    ]
    expect(groupByApiRound(msgs)).toEqual([0, 1, 3])
  })

  test('AI-only sequence (no human) — first AI seeds a round', () => {
    const msgs = [msg('ai', { id: 'r1' }), msg('tool'), msg('tool')]
    expect(groupByApiRound(msgs)).toEqual([0])
  })
})

describe('recentRoundCutoff', () => {
  test('returns 0 when fewer rounds than asked', () => {
    expect(recentRoundCutoff([msg('human'), msg('ai')], 5)).toBe(0)
  })

  test('returns the index of the round-N-from-end boundary', () => {
    const msgs = [
      msg('human'), // round 0
      msg('ai', { id: 'r0' }),
      msg('human'), // round 1
      msg('ai', { id: 'r1' }),
      msg('human'), // round 2
      msg('ai', { id: 'r2' }),
    ]
    // 6 round boundaries (each human + each AI). recent 1 = last AI at 5.
    expect(recentRoundCutoff(msgs, 1)).toBe(5)
    // recent 2 = last human + last AI = idx 4.
    expect(recentRoundCutoff(msgs, 2)).toBe(4)
    // recent 4 = preceding turn pair start.
    expect(recentRoundCutoff(msgs, 4)).toBe(2)
  })

  test('n <= 0 returns end of array (everything is recent)', () => {
    expect(recentRoundCutoff([msg('human')], 0)).toBe(1)
  })
})

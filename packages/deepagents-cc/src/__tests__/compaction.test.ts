/**
 * Pure compaction-helper tests.
 *
 * The full multi-tier middleware uses langchain message instances; we test
 * the bits that don't (pinning markers, token estimation, hash-based dedup
 * primitives) so the suite can run without the lib installed.
 */

import { describe, expect, test } from 'bun:test'
import {
  djb2,
  isMessagePinned,
  pinMessage,
  roughTokenCount,
  stringifyContent,
} from '../lib/messageUtils.js'

describe('pinMessage / isMessagePinned', () => {
  test('round-trips on a plain message-shaped object', () => {
    const m: { content: string; additional_kwargs?: Record<string, unknown> } = {
      content: 'x',
    }
    expect(isMessagePinned(m)).toBe(false)
    pinMessage(m)
    expect(isMessagePinned(m)).toBe(true)
  })

  test('preserves existing additional_kwargs', () => {
    const m = { content: 'x', additional_kwargs: { custom: 'value' } }
    pinMessage(m)
    expect(m.additional_kwargs['custom']).toBe('value')
    expect((m.additional_kwargs as Record<string, unknown>)['__pinned']).toBe(true)
  })

  test('a fresh message starts unpinned', () => {
    expect(isMessagePinned({ content: 'x' })).toBe(false)
  })
})

describe('roughTokenCount', () => {
  test('approximates chars/4', () => {
    const msgs = [{ content: 'x'.repeat(40) }, { content: 'y'.repeat(80) }]
    expect(roughTokenCount(msgs)).toBe(10 + 20)
  })

  test('walks structured content blocks (text only)', () => {
    const m = {
      content: [
        { type: 'text', text: 'a'.repeat(40) },
        { type: 'image', source: {} },
        { type: 'text', text: 'b'.repeat(40) },
      ],
    }
    // 40 + "\n" + 40 = 81 chars → ceil(81/4) = 21 tokens.
    expect(roughTokenCount([m])).toBe(21)
  })

  test('zero for empty content', () => {
    expect(roughTokenCount([{ content: '' }])).toBe(0)
    expect(roughTokenCount([])).toBe(0)
  })
})

describe('stringifyContent', () => {
  test('returns string content directly', () => {
    expect(stringifyContent({ content: 'hello' })).toBe('hello')
  })

  test('joins text blocks with newlines', () => {
    expect(
      stringifyContent({
        content: [
          { type: 'text', text: 'a' },
          { type: 'text', text: 'b' },
        ],
      }),
    ).toBe('a\nb')
  })

  test('skips non-text blocks', () => {
    expect(
      stringifyContent({
        content: [
          { type: 'text', text: 'visible' },
          { type: 'image', source: {} },
        ],
      }),
    ).toBe('visible')
  })
})

describe('djb2', () => {
  test('produces stable hex strings', () => {
    expect(djb2('hello')).toMatch(/^[0-9a-f]+$/)
    expect(djb2('hello')).toBe(djb2('hello'))
  })

  test('different inputs hash differently', () => {
    expect(djb2('a')).not.toBe(djb2('b'))
  })

  test('handles empty input', () => {
    expect(djb2('')).toBe((5381).toString(16))
  })
})

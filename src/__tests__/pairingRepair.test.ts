import { describe, expect, test } from 'bun:test'
import {
  repairPairing,
  SYNTHETIC_TOOL_RESULT_PLACEHOLDER,
  type MessageLike,
} from '../lib/pairingRepair.js'

const ai = (calls: Array<{ id: string; name?: string }>): MessageLike => ({
  role: 'ai',
  content: '',
  tool_calls: calls,
})

const tool = (
  id: string,
  content = 'ok',
  status: 'success' | 'error' = 'success',
): MessageLike => ({
  role: 'tool',
  content,
  tool_call_id: id,
  status,
})

const human = (text: string): MessageLike => ({ role: 'human', content: text })

describe('repairPairing', () => {
  test('passes through clean transcripts unchanged', () => {
    const msgs = [human('hi'), ai([{ id: 'a' }]), tool('a')]
    const r = repairPairing(msgs)
    expect(r.changed).toBe(false)
    expect(r.messages).toEqual(msgs)
  })

  test('synthesises placeholder for orphan tool_use', () => {
    const msgs = [human('hi'), ai([{ id: 'a', name: 'Bash' }, { id: 'b', name: 'Read' }]), tool('a')]
    const r = repairPairing(msgs)
    expect(r.changed).toBe(true)
    expect(r.added).toBe(1)
    expect(r.dropped).toBe(0)
    // Synthetic appears right after the AI message, after the existing tool_result for 'a'.
    const idx = r.messages.findIndex(
      m => m.role === 'tool' && m.tool_call_id === 'b',
    )
    expect(idx).toBeGreaterThan(-1)
    expect(r.messages[idx]!.content).toBe(SYNTHETIC_TOOL_RESULT_PLACEHOLDER)
    expect(r.messages[idx]!.status).toBe('error')
    expect(r.messages[idx]!.name).toBe('Read')
  })

  test('drops orphan tool_result without matching tool_use', () => {
    const msgs = [human('hi'), ai([{ id: 'a' }]), tool('a'), tool('zombie', 'should be dropped')]
    const r = repairPairing(msgs)
    expect(r.changed).toBe(true)
    expect(r.dropped).toBe(1)
    expect(r.messages.find(m => m.role === 'tool' && m.tool_call_id === 'zombie')).toBeUndefined()
  })

  test('dedupes duplicate tool_use ids (later wins)', () => {
    const msgs = [
      ai([{ id: 'a', name: 'Bash' }]),
      tool('a'),
      ai([{ id: 'a', name: 'Bash' }]),
      tool('a', 'second'),
    ]
    const r = repairPairing(msgs)
    expect(r.deduplicated).toBeGreaterThan(0)
    const aiCalls = r.messages.filter(m => m.role === 'ai').flatMap(m => m.tool_calls ?? [])
    expect(aiCalls.map(t => t.id)).toEqual(['a'])
    const toolMessages = r.messages.filter(m => m.role === 'tool')
    expect(toolMessages.length).toBe(1)
  })

  test('strict mode throws on orphan', () => {
    const msgs = [ai([{ id: 'a' }, { id: 'b' }]), tool('a')]
    expect(() => repairPairing(msgs, { strict: true })).toThrow(/orphan tool_use/)
  })

  test('strict mode throws on orphan tool_result', () => {
    expect(() =>
      repairPairing([tool('zombie')], { strict: true }),
    ).toThrow(/orphan tool_result/)
  })

  test('strict mode throws on duplicates', () => {
    const msgs = [ai([{ id: 'a' }]), tool('a'), tool('a')]
    expect(() => repairPairing(msgs, { strict: true })).toThrow(/duplicate/)
  })

  test('onRepair callback fires with counts', () => {
    let captured: Parameters<NonNullable<NonNullable<Parameters<typeof repairPairing>[1]>['onRepair']>>[0] | null = null
    repairPairing(
      [ai([{ id: 'a' }, { id: 'b' }]), tool('a'), tool('zombie')],
      {
        onRepair: info => {
          captured = info
        },
      },
    )
    expect(captured).not.toBeNull()
    expect(captured!.addedPlaceholders).toBe(1)
    expect(captured!.droppedOrphanResults).toBe(1)
  })

  test('handles empty input', () => {
    expect(repairPairing([]).changed).toBe(false)
  })
})

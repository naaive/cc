import { describe, expect, test } from 'bun:test'
import {
  analyzeContextBloat,
  type BloatMessage,
} from '../lib/contextBloat.js'

const ai = (calls: Array<{ id: string; name: string; args?: unknown }>): BloatMessage => ({
  role: 'ai',
  content: '',
  tool_calls: calls,
})
const tool = (id: string, content: string): BloatMessage => ({
  role: 'tool',
  content,
  tool_call_id: id,
})
const human = (text: string): BloatMessage => ({ role: 'human', content: text })

describe('analyzeContextBloat', () => {
  test('attributes tokens to tools by tool_call_id', () => {
    const msgs: BloatMessage[] = [
      human('hi'),
      ai([{ id: 'a', name: 'Bash' }, { id: 'b', name: 'Read' }]),
      tool('a', 'b'.repeat(800)), // 200 tokens
      tool('b', 'r'.repeat(400)), // 100 tokens
    ]
    const a = analyzeContextBloat(msgs)
    expect(a.byTool.get('Bash')?.tokens).toBe(200)
    expect(a.byTool.get('Read')?.tokens).toBe(100)
    expect(a.byTool.get('Bash')?.calls).toBe(1)
  })

  test('flags warning when tool exceeds warnPctOfTotal', () => {
    const msgs: BloatMessage[] = [
      human('q'),
      ai([{ id: 'a', name: 'Bash' }]),
      tool('a', 'x'.repeat(40_000)), // 10K tokens
      ai([{ id: 'b', name: 'Read' }]),
      tool('b', 'y'.repeat(2000)), // 500 tokens
    ]
    const a = analyzeContextBloat(msgs, { warnPctOfTotal: 0.5, infoPctOfTotal: 0.05 })
    const warn = a.suggestions.find(s => s.severity === 'warning')
    expect(warn?.toolName).toBe('Bash')
    expect(warn?.message).toContain('Bash output is taking')
    expect(warn?.message).toContain('head/tail/grep')
  })

  test('detects duplicate Read paths', () => {
    const msgs: BloatMessage[] = [
      ai([{ id: 'r1', name: 'Read', args: { file_path: '/a.ts' } }]),
      tool('r1', 'first read'),
      ai([{ id: 'r2', name: 'Read', args: { file_path: '/a.ts' } }]),
      tool('r2', 'second read'),
    ]
    const a = analyzeContextBloat(msgs)
    expect(a.duplicateReadPaths).toEqual(['/a.ts'])
    const dupSugg = a.suggestions.find(s =>
      s.message.includes('Re-read of'),
    )
    expect(dupSugg).toBeDefined()
  })

  test('returns no suggestions when every tool is below the threshold', () => {
    const msgs: BloatMessage[] = [
      ai([
        { id: 'a', name: 'Bash' },
        { id: 'b', name: 'Read' },
        { id: 'c', name: 'Grep' },
      ]),
      tool('a', 'x'.repeat(100)),
      tool('b', 'y'.repeat(100)),
      tool('c', 'z'.repeat(100)),
    ]
    // Each tool is ~33% of total — set thresholds above that to get nothing.
    const a = analyzeContextBloat(msgs, {
      infoPctOfTotal: 0.5,
      warnPctOfTotal: 0.6,
    })
    expect(a.suggestions.length).toBe(0)
  })

  test('warnings sorted before info; larger savings first', () => {
    const msgs: BloatMessage[] = [
      human('q'),
      ai([
        { id: 'a', name: 'Bash' },
        { id: 'b', name: 'Grep' },
        { id: 'c', name: 'Read' },
      ]),
      tool('a', 'x'.repeat(50_000)), // 25% (warning)
      tool('b', 'x'.repeat(20_000)), // 10% (info)
      tool('c', 'x'.repeat(30_000)), // 15% (info)
    ]
    const a = analyzeContextBloat(msgs, {
      warnPctOfTotal: 0.2,
      infoPctOfTotal: 0.05,
    })
    expect(a.suggestions[0]!.severity).toBe('warning')
    expect(a.suggestions[0]!.toolName).toBe('Bash')
  })

  test('caps suggestions at maxSuggestions', () => {
    const msgs: BloatMessage[] = [
      ai(
        Array.from({ length: 6 }, (_, i) => ({ id: `c${i}`, name: `T${i}` })),
      ),
      ...Array.from({ length: 6 }, (_, i) =>
        tool(`c${i}`, 'x'.repeat(8_000)),
      ),
    ]
    expect(analyzeContextBloat(msgs, { maxSuggestions: 3 }).suggestions.length).toBe(
      3,
    )
  })
})

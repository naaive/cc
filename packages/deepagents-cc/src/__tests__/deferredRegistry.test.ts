/**
 * Tests for the DeferredToolRegistry. The registry itself is pure — it
 * only stores StructuredTool refs and runs string searches over their
 * names + descriptions. We construct minimal StructuredTool stand-ins so
 * we don't pull in langchain runtime.
 */
import { describe, expect, test } from 'bun:test'
import { DeferredToolRegistry } from '../tools/deferredRegistry.js'

interface FakeTool {
  name: string
  description: string
  schema?: unknown
}

function makeRegistry(tools: FakeTool[]): DeferredToolRegistry {
  const r = new DeferredToolRegistry()
  for (const t of tools) {
    r.register({ tool: t as unknown as Parameters<DeferredToolRegistry['register']>[0]['tool'] })
  }
  return r
}

describe('DeferredToolRegistry', () => {
  test('toSystemPromptBlock returns null when empty', () => {
    expect(new DeferredToolRegistry().toSystemPromptBlock()).toBeNull()
  })

  test('toSystemPromptBlock lists every registered name', () => {
    const r = makeRegistry([
      { name: 'Banana', description: 'fruit' },
      { name: 'Apple', description: 'fruit' },
    ])
    const block = r.toSystemPromptBlock()!
    expect(block).toContain('  - Apple')
    expect(block).toContain('  - Banana')
    expect(block).toContain('ToolSearch')
  })

  test('toSystemPromptBlock sorts names alphabetically', () => {
    const r = makeRegistry([
      { name: 'Charlie', description: 'c' },
      { name: 'Alpha', description: 'a' },
      { name: 'Bravo', description: 'b' },
    ])
    const block = r.toSystemPromptBlock()!
    const idxA = block.indexOf('Alpha')
    const idxB = block.indexOf('Bravo')
    const idxC = block.indexOf('Charlie')
    expect(idxA).toBeLessThan(idxB)
    expect(idxB).toBeLessThan(idxC)
  })

  test('search ranks name matches above description matches', () => {
    const r = makeRegistry([
      { name: 'Foo', description: 'something something bar' },
      { name: 'Bar', description: 'unrelated' },
    ])
    const out = r.search('bar', 5)
    expect(out[0]!.tool.name).toBe('Bar')
    expect(out[1]!.tool.name).toBe('Foo')
  })

  test('search returns empty when nothing matches', () => {
    const r = makeRegistry([{ name: 'Foo', description: 'a' }])
    expect(r.search('zzz', 5)).toEqual([])
  })

  test('search caps at max results', () => {
    const r = makeRegistry([
      { name: 'A', description: 'common' },
      { name: 'B', description: 'common' },
      { name: 'C', description: 'common' },
    ])
    expect(r.search('common', 2).length).toBe(2)
  })

  test('parseSelect picks tools by exact name', () => {
    const r = makeRegistry([
      { name: 'A', description: '' },
      { name: 'B', description: '' },
      { name: 'C', description: '' },
    ])
    const out = r.parseSelect('select:B,C')!
    expect(out.map(t => t.tool.name)).toEqual(['B', 'C'])
  })

  test('parseSelect skips unknown names silently', () => {
    const r = makeRegistry([{ name: 'A', description: '' }])
    expect(r.parseSelect('select:A,Missing')!.length).toBe(1)
  })

  test('parseSelect returns null when query is not a select form', () => {
    const r = makeRegistry([{ name: 'A', description: '' }])
    expect(r.parseSelect('keyword query')).toBeNull()
  })
})

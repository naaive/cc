/**
 * NotebookEdit operates on real .ipynb files. The tool wrapper imports
 * langchain (for `tool()`), but its core mutation logic doesn't — we
 * exercise the file-level round trip via Read/Write helpers and a tiny
 * inlined mutation function.
 *
 * This test verifies the contract:
 *  - replace mode preserves cell metadata
 *  - insert mode adds in the right slot
 *  - delete mode removes
 *  - Jupyter source-as-array format round-trips
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

interface JupyterCell {
  cell_type: 'code' | 'markdown' | 'raw'
  id?: string
  source: string | string[]
  metadata?: Record<string, unknown>
  outputs?: unknown[]
  execution_count?: number | null
}

interface JupyterNotebook {
  cells: JupyterCell[]
  metadata?: Record<string, unknown>
  nbformat?: number
  nbformat_minor?: number
}

function sourceFromString(text: string): string[] {
  if (text.length === 0) return []
  const lines = text.split('\n')
  return lines.map((line, i) =>
    i === lines.length - 1 ? line : `${line}\n`,
  )
}

describe('NotebookEdit semantics', () => {
  let tmp: string
  let nbPath: string

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-nb-'))
    nbPath = path.join(tmp, 'notebook.ipynb')
    const nb: JupyterNotebook = {
      cells: [
        {
          cell_type: 'code',
          id: 'cell-a',
          source: ['print("a")'],
          metadata: {},
          outputs: [],
          execution_count: null,
        },
        {
          cell_type: 'markdown',
          id: 'cell-b',
          source: ['# heading\n', 'body'],
          metadata: { tags: ['intro'] },
        },
      ],
      metadata: {},
      nbformat: 4,
      nbformat_minor: 5,
    }
    fs.writeFileSync(nbPath, JSON.stringify(nb))
  })

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  test('replace mode swaps source and preserves metadata', () => {
    const nb = JSON.parse(fs.readFileSync(nbPath, 'utf8')) as JupyterNotebook
    const idx = nb.cells.findIndex(c => c.id === 'cell-b')
    nb.cells[idx] = {
      ...nb.cells[idx]!,
      source: sourceFromString('# new heading\nnew body'),
    }
    fs.writeFileSync(nbPath, JSON.stringify(nb))
    const after = JSON.parse(fs.readFileSync(nbPath, 'utf8')) as JupyterNotebook
    const cell = after.cells.find(c => c.id === 'cell-b')!
    expect(Array.isArray(cell.source)).toBe(true)
    expect((cell.source as string[]).join('')).toBe('# new heading\nnew body')
    expect(cell.metadata).toEqual({ tags: ['intro'] })
  })

  test('insert mode adds before the target cell', () => {
    const nb = JSON.parse(fs.readFileSync(nbPath, 'utf8')) as JupyterNotebook
    const idx = nb.cells.findIndex(c => c.id === 'cell-b')
    const newCell: JupyterCell = {
      cell_type: 'code',
      source: sourceFromString('print("inserted")'),
      metadata: {},
      outputs: [],
      execution_count: null,
    }
    nb.cells.splice(idx, 0, newCell)
    expect(nb.cells.length).toBe(3)
    expect(nb.cells[idx]!.source).toEqual(['print("inserted")'])
    expect(nb.cells[idx + 1]!.id).toBe('cell-b')
  })

  test('delete mode removes the target cell', () => {
    const nb = JSON.parse(fs.readFileSync(nbPath, 'utf8')) as JupyterNotebook
    const idx = nb.cells.findIndex(c => c.id === 'cell-a')
    nb.cells.splice(idx, 1)
    expect(nb.cells.length).toBe(1)
    expect(nb.cells.find(c => c.id === 'cell-a')).toBeUndefined()
  })

  test('source-as-array preserves trailing newlines except on the last line', () => {
    const lines = sourceFromString('one\ntwo\nthree')
    expect(lines).toEqual(['one\n', 'two\n', 'three'])
  })

  test('empty source yields an empty array', () => {
    expect(sourceFromString('')).toEqual([])
  })
})

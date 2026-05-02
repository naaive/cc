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
import { createNotebookEditTool } from '../tools/notebookEdit.js'
import { createFileStateGuard } from '../tools/fileStateGuard.js'
import { makeFileStateCache, resolveRoots } from '../tools/fsUtils.js'

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

describe('NotebookEdit goes through FileStateGuard', () => {
  let tmp: string
  let nbPath: string

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-nb-guard-'))
    nbPath = path.join(tmp, 'notebook.ipynb')
    fs.writeFileSync(
      nbPath,
      JSON.stringify({
        cells: [
          {
            cell_type: 'code',
            id: 'cell-a',
            source: ['print("a")'],
            metadata: {},
            outputs: [],
            execution_count: null,
          },
        ],
        metadata: {},
        nbformat: 4,
        nbformat_minor: 5,
      }),
    )
  })

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  test('refuses to edit without a prior Read (the deepening fix)', async () => {
    const cache = makeFileStateCache()
    const guard = createFileStateGuard({ cache, roots: resolveRoots(tmp) })
    const tool = createNotebookEditTool({ fileStateGuard: guard })
    await expect(
      tool.invoke({
        notebook_path: nbPath,
        new_source: 'print("b")',
        cell_id: 'cell-a',
      }),
    ).rejects.toThrow(/Read .* before editing/)
  })

  test('succeeds once the file has been Read first', async () => {
    const cache = makeFileStateCache()
    const guard = createFileStateGuard({ cache, roots: resolveRoots(tmp) })
    // Simulate a prior Read by recording the live mtime.
    const stat = fs.statSync(nbPath)
    guard.record(nbPath, stat.mtimeMs)
    const tool = createNotebookEditTool({ fileStateGuard: guard })
    const out = await tool.invoke({
      notebook_path: nbPath,
      new_source: 'print("b")',
      cell_id: 'cell-a',
    })
    expect(out).toContain('replaced cell cell-a')
    const after = JSON.parse(fs.readFileSync(nbPath, 'utf8')) as {
      cells: Array<{ source: string[] }>
    }
    expect(after.cells[0]!.source.join('')).toBe('print("b")')
  })
})

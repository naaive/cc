/**
 * NotebookEdit — . Edits a Jupyter notebook (.ipynb) by cell id.
 *
 * The notebook is loaded as JSON, mutated, then atomically rewritten via
 * the same `tmp + rename` path Write/Edit use. Three modes:
 *  - replace: swap cell_id's source with new_source.
 *  - insert: insert a new cell at cell_id's position (or at the end if
 *    cell_id is null). cell_type must be "code" or "markdown".
 *  - delete: remove cell_id.
 *
 * Our Notebook semantics — newline preservation, source-as-array — are
 * matched here so notebooks remain valid Jupyter docs after editing.
 */

import fs from 'node:fs'
import { tool } from 'langchain'
import { z } from 'zod/v4'
import { TOOL_DESCRIPTIONS, TOOL_NAMES } from './toolNames.js'
import { ensureAbsolute, writeTextFile } from './fsUtils.js'

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

const schema = z.object({
  notebook_path: z.string().describe('Absolute path to the .ipynb file.'),
  new_source: z.string().describe('New source content for the cell (replace/insert modes).'),
  cell_id: z
    .string()
    .nullable()
    .optional()
    .describe('Target cell id. For insert mode, null/undefined appends at the end.'),
  cell_type: z
    .enum(['code', 'markdown'])
    .optional()
    .describe('Required for insert mode.'),
  edit_mode: z.enum(['replace', 'insert', 'delete']).optional().describe('Default: replace.'),
})

export function createNotebookEditTool() {
  return tool(
    (input: z.infer<typeof schema>) => {
      const abs = ensureAbsolute(input.notebook_path, 'notebook_path')
      if (!abs.endsWith('.ipynb')) {
        throw new Error(`notebook_path must end with .ipynb (got ${abs})`)
      }
      const raw = fs.readFileSync(abs, 'utf8')
      const nb = JSON.parse(raw) as JupyterNotebook
      if (!Array.isArray(nb.cells)) {
        throw new Error(`malformed notebook: ${abs} has no cells array`)
      }

      const mode = input.edit_mode ?? 'replace'
      if (mode === 'insert') {
        if (!input.cell_type) {
          throw new Error(`cell_type is required for insert mode`)
        }
        const newCell: JupyterCell = {
          cell_type: input.cell_type,
          source: sourceFromString(input.new_source),
          metadata: {},
          ...(input.cell_type === 'code' ? { outputs: [], execution_count: null } : {}),
        }
        if (input.cell_id) {
          const idx = nb.cells.findIndex(c => c.id === input.cell_id)
          if (idx === -1) throw new Error(`cell_id not found: ${input.cell_id}`)
          nb.cells.splice(idx, 0, newCell)
        } else {
          nb.cells.push(newCell)
        }
      } else {
        if (!input.cell_id) {
          throw new Error(`cell_id is required for ${mode} mode`)
        }
        const idx = nb.cells.findIndex(c => c.id === input.cell_id)
        if (idx === -1) throw new Error(`cell_id not found: ${input.cell_id}`)
        if (mode === 'delete') {
          nb.cells.splice(idx, 1)
        } else {
          nb.cells[idx] = {
            ...nb.cells[idx]!,
            source: sourceFromString(input.new_source),
          }
        }
      }

      writeTextFile(abs, JSON.stringify(nb, null, 1))
      return `${mode}d cell ${input.cell_id ?? '<new>'} in ${abs}`
    },
    {
      name: TOOL_NAMES.NotebookEdit,
      description: TOOL_DESCRIPTIONS.NotebookEdit,
      schema,
    },
  )
}

/**
 * Jupyter stores cell source as either a single string or an array of
 * strings (one per line, with trailing newlines preserved). The array
 * form is what nbformat-1.4 readers expect for round-trip fidelity.
 */
function sourceFromString(text: string): string[] {
  if (text.length === 0) return []
  const lines = text.split('\n')
  return lines.map((line, i) =>
    i === lines.length - 1 ? line : `${line}\n`,
  )
}

/**
 * Read tool — name, plus three context-engineering tricks:
 *
 *   1. **File-unchanged stub.** When the model Reads the same file twice
 *      and the mtime hasn't changed, return a tiny stub.
 *   2. **Storage-URI passthrough.** `forge-store://<id>` paths return the
 *      content stashed by the eviction middleware.
 *   3. **Path recovery.** ENOENT errors get a "Did you mean ...?" hint
 *      computed from a Levenshtein scan of the parent dir + a basename
 *      walk under cwd.
 *
 * Plus media support — when the file is an image (PNG/JPG/GIF/WEBP) or
 * a PDF, we return content blocks (image / document) instead of plain
 * text so the model can see them. Text reading stays the default.
 *
 * Plus `additionalDirectories` boundary check from settings.
 */

import fs from 'node:fs'
import path from 'node:path'
import { tool } from 'langchain'
import { z } from 'zod'
import { TOOL_DESCRIPTIONS, TOOL_NAMES } from './toolNames.js'
import {
  addLineNumbers,
  DEFAULT_READ_LIMIT,
  enforceBoundary,
  ensureAbsolute,
  readTextFile,
  resolveRoots,
  statMtime,
  type FileStateCache,
} from './fsUtils.js'
import { parseStorageUri, type ResultStore } from './resultStore.js'
import { pathRecoveryHint } from './pathRecovery.js'

const schema = z.object({
  file_path: z
    .string()
    .describe('Absolute path to the file. Use forge-store://<id> to fetch a previously evicted tool result.'),
  offset: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe('Zero-based line offset for paging through long files.'),
  limit: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(`Max lines to return (default ${DEFAULT_READ_LIMIT}).`),
})

export interface ReadToolOptions {
  fileStateCache: FileStateCache
  resultStore?: ResultStore
  /** Working directory (used by path recovery + boundary checks). */
  cwd?: string
  /** Extra directories the Read tool may touch beyond cwd. */
  additionalDirectories?: readonly string[]
  /** Hook invoked when a file is read — used by conditional skill activation. */
  onFileRead?: (absPath: string) => void
}

export const FILE_UNCHANGED_STUB =
  'File unchanged since last Read. The content from the earlier Read tool_result in this conversation is still current — refer to that instead of re-reading.'

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp'])
const PDF_EXT = '.pdf'
const NOTEBOOK_EXT = '.ipynb'

type MediaHandler = (absPath: string) => unknown

export function createReadTool(options: ReadToolOptions) {
  const roots = resolveRoots(
    options.cwd ?? process.cwd(),
    options.additionalDirectories ?? [],
  )
  const mediaHandlers = new Map<string, MediaHandler>()
  for (const ext of IMAGE_EXTS) mediaHandlers.set(ext, p => readImageContent(p, ext))
  mediaHandlers.set(PDF_EXT, readPdfContent)
  mediaHandlers.set(NOTEBOOK_EXT, readNotebookContent)

  return tool(
    (input: z.infer<typeof schema>) => {
      const storeId = parseStorageUri(input.file_path)
      if (storeId) {
        if (!options.resultStore) {
          return `(no result store configured for ${input.file_path})`
        }
        const entry = options.resultStore.get(storeId)
        if (!entry) return `(unknown storage id: ${storeId})`
        return `${entry.content}\n\n[restored from ${input.file_path} — original tool: ${entry.toolName}, ${entry.size} bytes]`
      }

      const abs = ensureAbsolute(input.file_path, 'file_path')
      enforceBoundary(abs, roots)

      const known = options.fileStateCache.get(abs)
      const live = statMtime(abs)
      if (live === undefined) {
        const hint = pathRecoveryHint(abs, roots.cwd)
        throw new Error(`file not found: ${abs}${hint ? `\n\n${hint}` : ''}`)
      }
      if (
        known !== undefined &&
        Math.abs(known - live) < 1 &&
        input.offset == null &&
        input.limit == null
      ) {
        return FILE_UNCHANGED_STUB
      }

      const ext = path.extname(abs).toLowerCase()
      const mediaHandler = mediaHandlers.get(ext)
      if (mediaHandler) {
        options.fileStateCache.set(abs, live)
        options.onFileRead?.(abs)
        return mediaHandler(abs)
      }

      const result = readTextFile(abs, {
        offset: input.offset,
        limit: input.limit,
      })
      options.fileStateCache.set(abs, result.mtimeMs)
      options.onFileRead?.(abs)
      const startLine = (input.offset ?? 0) + 1
      const numbered = addLineNumbers(result.text, startLine)
      const tail = result.truncated
        ? `\n\n[showed lines ${startLine}-${startLine + result.text.split('\n').length - 1} of ${result.totalLines}; pass offset to read more]`
        : ''
      return `${numbered}${tail}`
    },
    {
      name: TOOL_NAMES.Read,
      description: TOOL_DESCRIPTIONS.Read,
      schema,
    },
  )
}


/**
 * Return image content blocks for the langchain ToolMessage. The Anthropic
 * API expects `image` content blocks with base64 data; we encode the raw
 * bytes here.
 */
function readImageContent(absPath: string, ext: string): unknown[] {
  const raw = fs.readFileSync(absPath)
  const media = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : `image/${ext.slice(1)}`
  return [
    {
      type: 'image',
      source: {
        type: 'base64',
        media_type: media,
        data: raw.toString('base64'),
      },
    },
    {
      type: 'text',
      text: `[image ${absPath}, ${raw.length} bytes, ${media}]`,
    },
  ]
}

/**
 * PDFs are returned as `document` content blocks (Anthropic native PDF
 * support). The model sees them as "documents" and can answer questions
 * over them. Caps the file size — large PDFs should be paged via a
 * dedicated extractor outside this tool.
 */
function readPdfContent(absPath: string): unknown[] {
  const raw = fs.readFileSync(absPath)
  const MAX_PDF = 30 * 1024 * 1024
  if (raw.length > MAX_PDF) {
    return [
      {
        type: 'text',
        text: `[refusing to attach: PDF too large (${raw.length} bytes > ${MAX_PDF})]`,
      },
    ]
  }
  return [
    {
      type: 'document',
      source: {
        type: 'base64',
        media_type: 'application/pdf',
        data: raw.toString('base64'),
      },
    },
    {
      type: 'text',
      text: `[pdf ${absPath}, ${raw.length} bytes]`,
    },
  ]
}

/**
 * Render a Jupyter notebook as a flat text dump: each cell as its own
 * section with cell_type + id + source + outputs. Cheaper than attaching
 * the .ipynb verbatim and far easier for the model to reason about.
 */
function readNotebookContent(absPath: string): string {
  const raw = fs.readFileSync(absPath, 'utf8')
  let nb: {
    cells: Array<{
      cell_type: string
      id?: string
      source: string | string[]
      outputs?: Array<{ output_type?: string; text?: string | string[]; data?: Record<string, unknown> }>
    }>
  }
  try {
    nb = JSON.parse(raw)
  } catch {
    return `[malformed notebook: ${absPath}]`
  }
  const sections = nb.cells.map((cell, i) => {
    const id = cell.id ?? `cell-${i}`
    const src = jupyterSourceToString(cell.source)
    let block = `## ${cell.cell_type} cell ${id}\n${src}`
    if (cell.cell_type === 'code' && cell.outputs && cell.outputs.length > 0) {
      const outs = cell.outputs
        .map(o => {
          if (o.text) return jupyterSourceToString(o.text)
          if (o.data && typeof o.data['text/plain'] === 'string') return o.data['text/plain']
          if (o.data) return `[output: ${Object.keys(o.data).join(', ')}]`
          return ''
        })
        .filter(Boolean)
      if (outs.length > 0) block += `\n\n--- output ---\n${outs.join('\n')}`
    }
    return block
  })
  return sections.join('\n\n')
}

/** Jupyter cells store source as `string | string[]`. Re-used in NotebookEdit. */
export function jupyterSourceToString(source: string | string[]): string {
  return Array.isArray(source) ? source.join('') : source
}

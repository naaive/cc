/**
 * Read tool — cc-aligned name, plus the two cc context-engineering tricks:
 *
 *   1. **File-unchanged stub.** When the model Reads the same file twice
 *      and the mtime hasn't changed, we return a tiny stub instructing
 *      the model to refer back to the earlier tool_result. cc's
 *      `FILE_UNCHANGED_STUB` saves a lot of tokens on iterative reading
 *      flows (Read → Edit → Read → Edit).
 *
 *   2. **Storage-URI passthrough.** If `file_path` is a `ccx-store://`
 *      URI, we treat it as an eviction-store id and return the stored
 *      tool result instead of touching the disk. That's how the eviction
 *      middleware lets the model re-fetch a previously evicted big
 *      result on demand.
 */

import { tool } from 'langchain'
import { z } from 'zod/v4'
import { TOOL_DESCRIPTIONS, TOOL_NAMES } from './ccToolNames.js'
import {
  addLineNumbers,
  DEFAULT_READ_LIMIT,
  ensureAbsolute,
  readTextFile,
  statMtime,
  type FileStateCache,
} from './fsUtils.js'
import { parseStorageUri, type ResultStore } from './resultStore.js'

const schema = z.object({
  file_path: z
    .string()
    .describe('Absolute path to the file. Use ccx-store://<id> to fetch a previously evicted tool result.'),
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
  /** Optional store: when set, ccx-store:// paths return stashed tool results. */
  resultStore?: ResultStore
}

export const FILE_UNCHANGED_STUB =
  'File unchanged since last Read. The content from the earlier Read tool_result in this conversation is still current — refer to that instead of re-reading.'

export function createReadTool(options: ReadToolOptions) {
  return tool(
    (input: z.infer<typeof schema>) => {
      // Storage-URI fast path: bypass disk and return the evicted result.
      const storeId = parseStorageUri(input.file_path)
      if (storeId) {
        if (!options.resultStore) {
          return `(no result store configured for ${input.file_path})`
        }
        const entry = options.resultStore.get(storeId)
        if (!entry) {
          return `(unknown storage id: ${storeId})`
        }
        return `${entry.content}\n\n[restored from ${input.file_path} — original tool: ${entry.toolName}, ${entry.size} bytes]`
      }

      const abs = ensureAbsolute(input.file_path, 'file_path')

      // File-unchanged stub: only trip when there's no offset/limit, since
      // a paged re-read with a different range is a legitimate operation.
      const known = options.fileStateCache.get(abs)
      const live = statMtime(abs)
      if (
        known !== undefined &&
        live !== undefined &&
        Math.abs(known - live) < 1 &&
        input.offset == null &&
        input.limit == null
      ) {
        return FILE_UNCHANGED_STUB
      }

      const result = readTextFile(abs, {
        offset: input.offset,
        limit: input.limit,
      })
      options.fileStateCache.set(abs, result.mtimeMs)
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

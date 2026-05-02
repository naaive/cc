/**
 * read_file — cc-style. Real disk, line-numbered output, offset+limit paging,
 * binary-file refusal, mtime-tracked for the stale-edit guard in edit_file.
 */

import { tool } from 'langchain'
import { z } from 'zod/v4'
import {
  addLineNumbers,
  DEFAULT_READ_LIMIT,
  ensureAbsolute,
  readTextFile,
  type FileStateCache,
} from './fsUtils.js'

const schema = z.object({
  file_path: z.string().describe('Absolute path to the file. Relative paths are rejected.'),
  offset: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe('Zero-based line offset. Use with `limit` to page through large files.'),
  limit: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(`Max lines to return (default ${DEFAULT_READ_LIMIT}).`),
})

const description = `Read a file from disk and return its content with line numbers.

Notes:
 - file_path must be ABSOLUTE.
 - Output is formatted like \`cat -n\`: \`<line_no>\\t<content>\`.
 - Long lines are truncated to 2000 chars; large files are paginated via offset+limit.
 - Binary files (NUL byte detected in first 8KB) are refused.`

export interface ReadFileToolOptions {
  fileStateCache: FileStateCache
}

export function createReadFileTool(options: ReadFileToolOptions) {
  return tool(
    (input: z.infer<typeof schema>) => {
      const abs = ensureAbsolute(input.file_path, 'file_path')
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
    { name: 'read_file', description, schema },
  )
}

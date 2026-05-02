/**
 * Read tool — cc-aligned name and description.
 *
 * Reads from real disk, returns `cat -n`-style numbered output, supports
 * offset/limit paging, refuses binary files, and tracks mtime for the
 * stale-edit guard in the Edit tool.
 */

import { tool } from 'langchain'
import { z } from 'zod/v4'
import { TOOL_DESCRIPTIONS, TOOL_NAMES } from './ccToolNames.js'
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
}

export function createReadTool(options: ReadToolOptions) {
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
    {
      name: TOOL_NAMES.Read,
      description: TOOL_DESCRIPTIONS.Read,
      schema,
    },
  )
}

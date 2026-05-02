/**
 * write_file — atomic, real-disk writes.
 *
 * Refuses to overwrite a file that has changed on disk since the last
 * read_file (same stale-write guard cc uses). To create a brand-new file
 * the model must NOT have read it first; to overwrite an existing file it
 * must have read it (so the cache has a known mtime).
 */

import fs from 'node:fs'
import { tool } from 'langchain'
import { z } from 'zod/v4'
import {
  ensureAbsolute,
  statMtime,
  writeTextFile,
  type FileStateCache,
} from './fsUtils.js'

const schema = z.object({
  file_path: z.string().describe('Absolute path to write.'),
  content: z.string().describe('Full file content.'),
})

const description = `Write a file to disk atomically.

Rules:
 - file_path must be ABSOLUTE.
 - Overwriting an existing file requires you to have read it earlier in this session
   (so we can detect concurrent edits). If you have not, call read_file first.
 - Parent directories are created automatically.
 - This is the right tool for creating brand-new files. For modifying part of an
   existing file, prefer edit_file.`

export interface WriteFileToolOptions {
  fileStateCache: FileStateCache
}

export function createWriteFileTool(options: WriteFileToolOptions) {
  return tool(
    (input: z.infer<typeof schema>) => {
      const abs = ensureAbsolute(input.file_path, 'file_path')
      const existing = statMtime(abs)
      if (existing !== undefined) {
        const known = options.fileStateCache.get(abs)
        if (known === undefined) {
          throw new Error(
            `${abs} exists. Read it first (or pick a different path) so I can detect concurrent edits.`,
          )
        }
        if (Math.abs(known - existing) > 1) {
          throw new Error(
            `${abs} changed on disk since the last read. Re-read it before writing.`,
          )
        }
      }
      writeTextFile(abs, input.content)
      const newMtime = fs.statSync(abs).mtimeMs
      options.fileStateCache.set(abs, newMtime)
      const action = existing === undefined ? 'created' : 'overwrote'
      return `${action} ${abs} (${input.content.length} bytes)`
    },
    { name: 'write_file', description, schema },
  )
}

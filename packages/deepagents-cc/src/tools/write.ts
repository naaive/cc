/**
 * Write tool — cc-aligned. Atomic real-disk writes with the read-before-write
 * guard so we never silently clobber a file the model hasn't seen.
 */

import fs from 'node:fs'
import { tool } from 'langchain'
import { z } from 'zod/v4'
import { TOOL_DESCRIPTIONS, TOOL_NAMES } from './ccToolNames.js'
import {
  enforceBoundary,
  ensureAbsolute,
  resolveRoots,
  statMtime,
  writeTextFile,
  type FileStateCache,
} from './fsUtils.js'

const schema = z.object({
  file_path: z.string().describe('Absolute path to write.'),
  content: z.string().describe('Full file content.'),
})

export interface WriteToolOptions {
  fileStateCache: FileStateCache
  cwd?: string
  additionalDirectories?: readonly string[]
}

export function createWriteTool(options: WriteToolOptions) {
  const roots = resolveRoots(
    options.cwd ?? process.cwd(),
    options.additionalDirectories ?? [],
  )
  return tool(
    (input: z.infer<typeof schema>) => {
      const abs = ensureAbsolute(input.file_path, 'file_path')
      enforceBoundary(abs, roots)
      const existing = statMtime(abs)
      if (existing !== undefined) {
        const known = options.fileStateCache.get(abs)
        if (known === undefined) {
          throw new Error(
            `${abs} exists. Use the Read tool to read it first, then call Write.`,
          )
        }
        if (Math.abs(known - existing) > 1) {
          throw new Error(
            `${abs} changed on disk since the last Read. Re-read it before writing.`,
          )
        }
      }
      writeTextFile(abs, input.content)
      const newMtime = fs.statSync(abs).mtimeMs
      options.fileStateCache.set(abs, newMtime)
      const action = existing === undefined ? 'created' : 'overwrote'
      return `${action} ${abs} (${input.content.length} bytes)`
    },
    {
      name: TOOL_NAMES.Write,
      description: TOOL_DESCRIPTIONS.Write,
      schema,
    },
  )
}

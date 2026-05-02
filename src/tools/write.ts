/**
 * Write tool — atomic real-disk writes with the read-before-write guard so
 * we never silently clobber a file the model hasn't seen.
 */

import { tool } from 'langchain'
import { z } from 'zod'
import { TOOL_DESCRIPTIONS, TOOL_NAMES } from './toolNames.js'
import {
  enforceBoundary,
  ensureAbsolute,
  resolveRoots,
  writeTextFile,
} from './fsUtils.js'
import { liveMtime, type FileStateGuard } from './fileStateGuard.js'

const schema = z.object({
  file_path: z.string().describe('Absolute path to write.'),
  content: z.string().describe('Full file content.'),
})

export interface WriteToolOptions {
  fileStateGuard: FileStateGuard
  cwd?: string
  additionalDirectories?: readonly string[]
}

export function createWriteTool(options: WriteToolOptions) {
  const roots = resolveRoots(
    options.cwd ?? process.cwd(),
    options.additionalDirectories ?? [],
  )
  const { fileStateGuard: guard } = options
  return tool(
    (input: z.infer<typeof schema>) => {
      const abs = ensureAbsolute(input.file_path, 'file_path')
      enforceBoundary(abs, roots)
      const { existed } = guard.checkWrite(abs)
      writeTextFile(abs, input.content)
      guard.record(abs, liveMtime(abs))
      const action = existed ? 'overwrote' : 'created'
      return `${action} ${abs} (${input.content.length} bytes)`
    },
    {
      name: TOOL_NAMES.Write,
      description: TOOL_DESCRIPTIONS.Write,
      schema,
    },
  )
}

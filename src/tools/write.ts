/**
 * Write tool — atomic real-disk write. Read-before-overwrite invariant and
 * boundary checks live in `FileStateGuard`.
 */

import { tool } from 'langchain'
import { z } from 'zod'
import { TOOL_DESCRIPTIONS, TOOL_NAMES } from './toolNames.js'
import { writeTextFile } from './fsUtils.js'
import { liveMtime, type FileStateGuard } from './fileStateGuard.js'

const schema = z.object({
  file_path: z.string().describe('Absolute path to write.'),
  content: z.string().describe('Full file content.'),
})

export interface WriteToolOptions {
  fileStateGuard: FileStateGuard
}

export function createWriteTool(options: WriteToolOptions) {
  const { fileStateGuard: guard } = options
  return tool(
    (input: z.infer<typeof schema>) => {
      const { abs, existed } = guard.prepareWrite(input.file_path)
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

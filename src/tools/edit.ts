/**
 * Edit tool — deterministic single-occurrence string replacement, plus
 * optional `replace_all` for renames. The read-before-edit invariant and
 * boundary checks live in `FileStateGuard`; this tool just performs the
 * mutation.
 */

import fs from 'node:fs'
import { tool } from 'langchain'
import { z } from 'zod'
import { TOOL_DESCRIPTIONS, TOOL_NAMES } from './toolNames.js'
import { applyDeterministicEdit, isBinaryFile, writeTextFile } from './fsUtils.js'
import { liveMtime, type FileStateGuard } from './fileStateGuard.js'

const schema = z.object({
  file_path: z.string().describe('Absolute path of the file to edit.'),
  old_string: z
    .string()
    .min(1)
    .describe('Exact text to replace. MUST be unique in the file unless replace_all=true.'),
  new_string: z.string().describe('Replacement text. Empty string deletes old_string.'),
  replace_all: z
    .boolean()
    .optional()
    .describe('Replace every occurrence of old_string. Default false.'),
})

export interface EditToolOptions {
  fileStateGuard: FileStateGuard
}

export function createEditTool(options: EditToolOptions) {
  const { fileStateGuard: guard } = options
  return tool(
    (input: z.infer<typeof schema>) => {
      const { abs } = guard.prepareEdit(input.file_path)
      if (isBinaryFile(abs)) {
        throw new Error(`refusing to edit binary file: ${abs}`)
      }
      const source = fs.readFileSync(abs, 'utf8')
      const next = applyDeterministicEdit(
        source,
        input.old_string,
        input.new_string,
        input.replace_all ?? false,
      )
      writeTextFile(abs, next)
      guard.record(abs, liveMtime(abs))
      const occurrences =
        input.replace_all
          ? source.split(input.old_string).length - 1
          : 1
      return `edited ${abs} (${occurrences} occurrence${occurrences === 1 ? '' : 's'} replaced)`
    },
    {
      name: TOOL_NAMES.Edit,
      description: TOOL_DESCRIPTIONS.Edit,
      schema,
    },
  )
}

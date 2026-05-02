/**
 * Edit tool — cc-aligned. Deterministic single-occurrence string replacement
 * with the read-before-edit guard, plus optional `replace_all` for renames.
 */

import fs from 'node:fs'
import { tool } from 'langchain'
import { z } from 'zod/v4'
import { TOOL_DESCRIPTIONS, TOOL_NAMES } from './ccToolNames.js'
import {
  applyDeterministicEdit,
  ensureAbsolute,
  isBinaryFile,
  isWithinAllowedRoots,
  statMtime,
  writeTextFile,
  type FileStateCache,
} from './fsUtils.js'

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
  fileStateCache: FileStateCache
  cwd?: string
  additionalDirectories?: readonly string[]
}

export function createEditTool(options: EditToolOptions) {
  const cwd = options.cwd ?? process.cwd()
  return tool(
    (input: z.infer<typeof schema>) => {
      const abs = ensureAbsolute(input.file_path, 'file_path')
      if (!isWithinAllowedRoots(abs, cwd, options.additionalDirectories ?? [])) {
        throw new Error(`${abs} is outside the allowed roots (cwd=${cwd}).`)
      }
      const known = options.fileStateCache.get(abs)
      if (known === undefined) {
        throw new Error(`Read ${abs} before editing it.`)
      }
      const live = statMtime(abs)
      if (live === undefined) throw new Error(`${abs} no longer exists`)
      if (Math.abs(known - live) > 1) {
        throw new Error(
          `${abs} changed on disk since the last read. Re-read it before editing.`,
        )
      }
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
      const newMtime = fs.statSync(abs).mtimeMs
      options.fileStateCache.set(abs, newMtime)
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

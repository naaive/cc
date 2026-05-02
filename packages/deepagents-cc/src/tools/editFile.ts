/**
 * edit_file — deterministic single-occurrence string replacement.
 *
 * Mirrors cc's FileEditTool semantics:
 *  - old_string must exist EXACTLY ONCE in the file (otherwise the model
 *    hasn't given enough context to disambiguate — it must add more lines
 *    or pass replace_all=true).
 *  - old_string === new_string is rejected (no-op).
 *  - The file must have been read earlier in this session (stale-edit guard).
 *  - Writes are atomic (tmp + rename).
 *
 * Why this matters: deepagents' edit_file is more permissive (regex / fuzzy
 * matching), which sounds nicer until you watch a model accidentally
 * replace a comment that happened to match. Strict equality + uniqueness
 * is the contract that keeps multi-file refactors safe.
 */

import fs from 'node:fs'
import { tool } from 'langchain'
import { z } from 'zod/v4'
import {
  applyDeterministicEdit,
  ensureAbsolute,
  isBinaryFile,
  statMtime,
  writeTextFile,
  type FileStateCache,
} from './fsUtils.js'

const schema = z.object({
  file_path: z.string().describe('Absolute path of the file to edit.'),
  old_string: z
    .string()
    .min(1)
    .describe(
      'Exact text to replace. MUST be unique in the file unless replace_all=true. Include enough surrounding context to be unambiguous.',
    ),
  new_string: z.string().describe('Replacement text. Empty string deletes old_string.'),
  replace_all: z
    .boolean()
    .optional()
    .describe('When true, replace every occurrence of old_string. Default false.'),
})

const description = `Edit a file by replacing an exact string.

Rules:
 - file_path must be ABSOLUTE and the file must have been read earlier in this session.
 - old_string must occur exactly once unless replace_all=true.
 - old_string === new_string is rejected. Empty new_string deletes old_string.
 - Write is atomic (tmp + rename); concurrent edits are detected via mtime.`

export interface EditFileToolOptions {
  fileStateCache: FileStateCache
}

export function createEditFileTool(options: EditFileToolOptions) {
  return tool(
    (input: z.infer<typeof schema>) => {
      const abs = ensureAbsolute(input.file_path, 'file_path')
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
    { name: 'edit_file', description, schema },
  )
}

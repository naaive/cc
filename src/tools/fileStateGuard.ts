/**
 * FileStateGuard — single seam for "what can the model do with this file?"
 *
 * Reads, writes, and edits all share three preconditions that the harness
 * cares about:
 *
 *   1. Read-before-edit: the model must have observed the current bytes
 *      before mutating them, so we never silently clobber human edits.
 *   2. Mtime-fresh: between the model's last Read and a write/edit, the
 *      file's mtime must not have moved.
 *   3. Storage-URI restoration: a `forge-store://<id>` path returned by
 *      Read isn't a real filesystem path — it points at a stashed tool
 *      result the eviction middleware tucked away.
 *
 * Before this guard each fs tool reimplemented these checks inline, which
 * meant changing the policy required touching three call sites and three
 * sets of error strings. The guard concentrates the policy: tools call
 * `checkRead` / `checkEdit` / `checkWrite` and forget about the cache.
 */

import fs from 'node:fs'
import { statMtime, type FileStateCache } from './fsUtils.js'
import { parseStorageUri, type ResultStore } from './resultStore.js'

export const FILE_UNCHANGED_STUB =
  'File unchanged since last Read. The content from the earlier Read tool_result in this conversation is still current — refer to that instead of re-reading.'

/** mtime difference (in ms) tolerated when comparing cache vs. live disk. */
const MTIME_TOLERANCE_MS = 1

export interface FileStateGuard {
  /**
   * Resolve a `forge-store://<id>` virtual path to its stashed content.
   * Returns null when `filePath` is a real filesystem path. The string
   * may itself be an error message ("unknown storage id …") — callers
   * forward it to the model as the tool result.
   */
  restoreFromStore(filePath: string): string | null

  /**
   * Decide what should happen when the model Reads `absPath`. Returns:
   *
   *  - `{ unchanged: true }` — the file is byte-identical to the cached
   *    Read; the caller should return `FILE_UNCHANGED_STUB` and NOT touch
   *    the cache.
   *  - `{ mtime }` — the caller should perform the read; the live mtime
   *    is provided so the caller doesn't need to re-`stat`. The caller is
   *    expected to call `record(absPath, mtime)` after a successful read.
   *
   * Throws when the file is missing.
   *
   * `paged` should be true when the caller is requesting a non-default
   * offset/limit slice — a paged read is never short-circuited because
   * the model is asking for a different window.
   */
  checkRead(absPath: string, paged: boolean): { unchanged: true } | { mtime: number }

  /**
   * Throws unless the model is allowed to edit `absPath` (i.e. it has been
   * Read in this session AND the on-disk mtime hasn't moved since).
   */
  checkEdit(absPath: string): void

  /**
   * Throws unless the model is allowed to Write to `absPath`. New files
   * are always allowed; overwriting an existing file requires a fresh
   * Read. Returns whether the file existed.
   */
  checkWrite(absPath: string): { existed: boolean }

  /** Record an mtime observation after a successful Read / Edit / Write. */
  record(absPath: string, mtime: number): void
}

export interface FileStateGuardOptions {
  cache: FileStateCache
  resultStore?: ResultStore | null
}

export function createFileStateGuard(
  options: FileStateGuardOptions,
): FileStateGuard {
  const { cache, resultStore } = options

  return {
    restoreFromStore(filePath) {
      const id = parseStorageUri(filePath)
      if (!id) return null
      if (!resultStore) return `(no result store configured for ${filePath})`
      const entry = resultStore.get(id)
      if (!entry) return `(unknown storage id: ${id})`
      return `${entry.content}\n\n[restored from ${filePath} — original tool: ${entry.toolName}, ${entry.size} bytes]`
    },

    checkRead(absPath, paged) {
      const live = statMtime(absPath)
      if (live === undefined) {
        throw new Error(`file not found: ${absPath}`)
      }
      const known = cache.get(absPath)
      if (
        !paged &&
        known !== undefined &&
        Math.abs(known - live) <= MTIME_TOLERANCE_MS
      ) {
        return { unchanged: true }
      }
      return { mtime: live }
    },

    checkEdit(absPath) {
      const known = cache.get(absPath)
      if (known === undefined) {
        throw new Error(`Read ${absPath} before editing it.`)
      }
      const live = statMtime(absPath)
      if (live === undefined) throw new Error(`${absPath} no longer exists`)
      if (Math.abs(known - live) > MTIME_TOLERANCE_MS) {
        throw new Error(
          `${absPath} changed on disk since the last read. Re-read it before editing.`,
        )
      }
    },

    checkWrite(absPath) {
      const existing = statMtime(absPath)
      if (existing === undefined) return { existed: false }
      const known = cache.get(absPath)
      if (known === undefined) {
        throw new Error(
          `${absPath} exists. Use the Read tool to read it first, then call Write.`,
        )
      }
      if (Math.abs(known - existing) > MTIME_TOLERANCE_MS) {
        throw new Error(
          `${absPath} changed on disk since the last Read. Re-read it before writing.`,
        )
      }
      return { existed: true }
    },

    record(absPath, mtime) {
      cache.set(absPath, mtime)
    },
  }
}

/** Convenience: live mtime of a file just touched, for `record(...)`. */
export function liveMtime(absPath: string): number {
  return fs.statSync(absPath).mtimeMs
}

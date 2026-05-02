/**
 * FileStateGuard — the single seam every fs tool calls into.
 *
 * The guard owns the entire "may the model operate on this path, and what
 * does it get back?" contract:
 *
 *  1. Path resolution: rejects relative paths, normalises `..`/`//`.
 *  2. Boundary enforcement: the path must sit under cwd or one of the
 *     host-whitelisted `additionalDirectories`.
 *  3. Read-before-edit invariant: an Edit/Write/NotebookEdit on an existing
 *     file requires a prior Read in this session, and the file's mtime must
 *     not have moved since.
 *  4. File-unchanged short-circuit: a re-Read of a file with the same mtime
 *     yields a tiny stub instead of re-shipping the bytes.
 *  5. Storage-URI restoration: a `forge-store://<id>` path returned by
 *     Read isn't a real filesystem path — it points at a stashed tool
 *     result the eviction middleware tucked away.
 *  6. Path-recovery hints: ENOENT errors carry a "Did you mean ...?"
 *     suggestion derived from a Levenshtein walk under cwd.
 *
 * Before the guard, each fs tool reimplemented these checks inline — five
 * call sites, five sets of error strings. After the guard, each tool calls
 * one method per operation and forgets about cache/roots/store.
 */

import fs from 'node:fs'
import path from 'node:path'
import {
  ensureAbsolute,
  enforceBoundary,
  resolveRoots,
  statMtime,
  type FileStateCache,
  type ResolvedRoots,
} from './fsUtils.js'
import { pathRecoveryHint } from './pathRecovery.js'
import { parseStorageUri, type ResultStore } from './resultStore.js'

export const FILE_UNCHANGED_STUB =
  'File unchanged since last Read. The content from the earlier Read tool_result in this conversation is still current — refer to that instead of re-reading.'

/** mtime difference (in ms) tolerated when comparing cache vs. live disk. */
const MTIME_TOLERANCE_MS = 1

/** Outcome of `prepareRead` — three exhaustive shapes the caller must handle. */
export type PreparedRead =
  | { kind: 'stored'; content: string }
  | { kind: 'unchanged' }
  | { kind: 'fresh'; abs: string; mtime: number }

export interface FileStateGuard {
  /**
   * Resolve a Read request. Three outcomes:
   *  - `stored`: the path was a `forge-store://<id>` URI; `content` is the
   *    payload to return verbatim.
   *  - `unchanged`: the file is byte-identical to the cached Read; caller
   *    should return `FILE_UNCHANGED_STUB`.
   *  - `fresh`: the caller should perform the read, then `record(abs, mtime)`.
   *
   * Throws on missing files (with a path-recovery hint), invalid paths,
   * and out-of-bounds reads.
   *
   * `paged` should be true when the caller is requesting a non-default
   * offset/limit slice — paged reads are never short-circuited because
   * the model is asking for a different window.
   */
  prepareRead(filePath: string, paged: boolean): PreparedRead

  /**
   * Resolve an Edit request. Returns the absolute, boundary-checked path
   * once the read-before-edit invariant has been satisfied.
   * Throws otherwise.
   */
  prepareEdit(filePath: string): { abs: string }

  /**
   * Resolve a Write request. Returns the absolute path plus whether the
   * file already existed. New files always pass; overwrites require a
   * prior Read on a fresh mtime.
   */
  prepareWrite(filePath: string): { abs: string; existed: boolean }

  /** Record an mtime observation after a successful Read / Edit / Write. */
  record(absPath: string, mtime: number): void
}

export interface FileStateGuardOptions {
  cache: FileStateCache
  resultStore?: ResultStore | null
  /**
   * Pre-resolved roots. Either pass `roots` directly or pass `cwd` (+
   * optional `additionalDirectories`) and the guard will resolve them.
   */
  roots?: ResolvedRoots
  cwd?: string
  additionalDirectories?: readonly string[]
}

export function createFileStateGuard(
  options: FileStateGuardOptions,
): FileStateGuard {
  const { cache, resultStore } = options
  const roots =
    options.roots ??
    resolveRoots(
      options.cwd ?? process.cwd(),
      options.additionalDirectories ?? [],
    )

  function restoreFromStore(filePath: string): string | null {
    const id = parseStorageUri(filePath)
    if (!id) return null
    if (!resultStore) return `(no result store configured for ${filePath})`
    const entry = resultStore.get(id)
    if (!entry) return `(unknown storage id: ${id})`
    return `${entry.content}\n\n[restored from ${filePath} — original tool: ${entry.toolName}, ${entry.size} bytes]`
  }

  function resolvePath(filePath: string, label: string): string {
    const abs = ensureAbsolute(filePath, label)
    enforceBoundary(abs, roots)
    return abs
  }

  return {
    prepareRead(filePath, paged) {
      const stored = restoreFromStore(filePath)
      if (stored !== null) return { kind: 'stored', content: stored }

      const abs = resolvePath(filePath, 'file_path')
      const live = statMtime(abs)
      if (live === undefined) {
        const hint = pathRecoveryHint(abs, roots.cwd)
        throw new Error(
          `file not found: ${abs}${hint ? `\n\n${hint}` : ''}`,
        )
      }
      const known = cache.get(abs)
      if (
        !paged &&
        known !== undefined &&
        Math.abs(known - live) <= MTIME_TOLERANCE_MS
      ) {
        return { kind: 'unchanged' }
      }
      return { kind: 'fresh', abs, mtime: live }
    },

    prepareEdit(filePath) {
      const abs = resolvePath(filePath, 'file_path')
      const known = cache.get(abs)
      if (known === undefined) {
        throw new Error(`Read ${abs} before editing it.`)
      }
      const live = statMtime(abs)
      if (live === undefined) throw new Error(`${abs} no longer exists`)
      if (Math.abs(known - live) > MTIME_TOLERANCE_MS) {
        throw new Error(
          `${abs} changed on disk since the last read. Re-read it before editing.`,
        )
      }
      return { abs }
    },

    prepareWrite(filePath) {
      const abs = resolvePath(filePath, 'file_path')
      const existing = statMtime(abs)
      if (existing === undefined) return { abs, existed: false }
      const known = cache.get(abs)
      if (known === undefined) {
        throw new Error(
          `${abs} exists. Use the Read tool to read it first, then call Write.`,
        )
      }
      if (Math.abs(known - existing) > MTIME_TOLERANCE_MS) {
        throw new Error(
          `${abs} changed on disk since the last Read. Re-read it before writing.`,
        )
      }
      return { abs, existed: true }
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

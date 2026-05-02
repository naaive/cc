/**
 * Filesystem helpers shared across read/write/edit/ls/glob/grep.
 *
 * Goal: match cc's real-disk semantics rather than deepagents' in-state
 * file map. cc's contract:
 *
 *  - Paths must be absolute. Relative paths are rejected up-front so the
 *    model can't accidentally drift on cwd changes mid-conversation.
 *  - read_file returns content with `cat -n`-style line prefixes.
 *  - edit_file requires `old_string` to occur exactly once (deterministic
 *    edits — no fuzzy matching).
 *  - read_file remembers the modification time it saw; edit_file rejects
 *    edits to files that changed on disk since then, so we never silently
 *    overwrite human edits.
 *  - Binary files are detected and refused (model can't usefully edit them).
 */

import fs from 'node:fs'
import path from 'node:path'

export const DEFAULT_READ_LIMIT = 2000
export const MAX_LINE_WIDTH = 2000

/** Per-tool-context map of "last time we read this file" for stale-edit detection. */
export interface FileStateCache {
  get(absPath: string): number | undefined
  set(absPath: string, mtimeMs: number): void
}

export function makeFileStateCache(): FileStateCache {
  const m = new Map<string, number>()
  return {
    get: p => m.get(p),
    set: (p, t) => {
      m.set(p, t)
    },
  }
}

export function ensureAbsolute(p: string, label = 'path'): string {
  if (!path.isAbsolute(p)) {
    throw new Error(`${label} must be an absolute path; got "${p}"`)
  }
  // Normalize to remove `..`, double slashes — but preserve symlinks.
  return path.normalize(p)
}

/**
 * Default directories every fs walker / boundary check ignores. Centralised
 * so glob, grep, and pathRecovery agree on the skip set.
 */
export const DEFAULT_SKIP_DIRS: ReadonlySet<string> = new Set([
  'node_modules',
  '.git',
  '.next',
  '.turbo',
  '.cache',
  '.venv',
  '__pycache__',
  'dist',
  'build',
  'target',
  'vendor',
  'coverage',
  'out',
])

/**
 * Pre-resolved roots for repeated boundary checks.
 *
 * cc lets the host whitelist extra directories (sibling repos, scratch
 * dirs). The check happens on every fs tool call, so we resolve once at
 * tool construction time rather than per call.
 */
export interface ResolvedRoots {
  /** Original cwd, resolved. */
  readonly cwd: string
  /** Resolved + de-duped allowed roots, including cwd. */
  readonly all: readonly string[]
}

export function resolveRoots(
  cwd: string,
  additionalDirectories: readonly string[] = [],
): ResolvedRoots {
  const seen = new Set<string>()
  const all: string[] = []
  for (const r of [cwd, ...additionalDirectories]) {
    const abs = path.resolve(r)
    if (!seen.has(abs)) {
      seen.add(abs)
      all.push(abs)
    }
  }
  return { cwd: path.resolve(cwd), all }
}

export function isWithinAllowedRoots(
  target: string,
  roots: ResolvedRoots,
): boolean {
  const abs = path.resolve(target)
  return roots.all.some(root => abs === root || abs.startsWith(`${root}/`))
}

export function enforceBoundary(target: string, roots: ResolvedRoots): void {
  if (isWithinAllowedRoots(target, roots)) return
  const list =
    roots.all.length === 1 ? roots.cwd : roots.all.join(', ')
  throw new Error(`${target} is outside the allowed roots (${list}).`)
}

/**
 * Detect binary files using a NUL-byte heuristic over the first 8KB.
 * Faster than mime-type sniffing and good enough for our use.
 */
export function isBinaryFile(filePath: string): boolean {
  try {
    const fd = fs.openSync(filePath, 'r')
    try {
      const buf = Buffer.alloc(8192)
      const n = fs.readSync(fd, buf, 0, buf.length, 0)
      for (let i = 0; i < n; i++) {
        if (buf[i] === 0) return true
      }
      return false
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    return false
  }
}

export function addLineNumbers(text: string, startLine = 1): string {
  const lines = text.split('\n')
  const width = String(startLine + lines.length - 1).length
  return lines
    .map((line, i) => `${String(startLine + i).padStart(width, ' ')}\t${line}`)
    .join('\n')
}

export function truncateLine(line: string, max = MAX_LINE_WIDTH): string {
  if (line.length <= max) return line
  return `${line.slice(0, max)} … [truncated to ${max} chars]`
}

export interface ReadFileResult {
  text: string
  /** Total lines in the file (not just what we returned). */
  totalLines: number
  /** mtime in ms — used by edit_file for stale-edit detection. */
  mtimeMs: number
  truncated: boolean
}

export function readTextFile(
  absPath: string,
  options: { offset?: number; limit?: number } = {},
): ReadFileResult {
  const offset = options.offset ?? 0
  const limit = options.limit ?? DEFAULT_READ_LIMIT
  if (offset < 0 || limit <= 0) {
    throw new Error('offset must be >= 0 and limit must be > 0')
  }
  const stat = fs.statSync(absPath)
  if (!stat.isFile()) throw new Error(`not a regular file: ${absPath}`)
  if (isBinaryFile(absPath)) {
    throw new Error(`refusing to read binary file: ${absPath}`)
  }
  const raw = fs.readFileSync(absPath, 'utf8')
  const lines = raw.split('\n')
  const totalLines = lines.length
  const slice = lines.slice(offset, offset + limit).map(l => truncateLine(l))
  const truncated = offset + limit < totalLines
  return {
    text: slice.join('\n'),
    totalLines,
    mtimeMs: stat.mtimeMs,
    truncated,
  }
}

/** Atomic write: tmp file + rename to avoid torn writes on crash. */
export function writeTextFile(absPath: string, content: string): void {
  fs.mkdirSync(path.dirname(absPath), { recursive: true })
  const tmp = `${absPath}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(tmp, content, { encoding: 'utf8' })
  fs.renameSync(tmp, absPath)
}

/** Mtime in ms, or undefined if the file doesn't exist. */
export function statMtime(absPath: string): number | undefined {
  try {
    return fs.statSync(absPath).mtimeMs
  } catch {
    return undefined
  }
}

/**
 * Replace exactly one occurrence of `oldString` with `newString`.
 * Errors when:
 *  - oldString isn't found
 *  - oldString occurs more than once (ambiguity → require more context)
 *  - oldString === newString (no-op edit)
 */
export function applyDeterministicEdit(
  source: string,
  oldString: string,
  newString: string,
  /** When true, replace every occurrence. Default false to mirror cc. */
  replaceAll = false,
): string {
  if (oldString === newString) {
    throw new Error('old_string and new_string are identical — no edit to apply')
  }
  if (oldString === '') {
    throw new Error('old_string must not be empty (use write_file to create files)')
  }
  if (replaceAll) {
    if (!source.includes(oldString)) {
      throw new Error('old_string not found in file')
    }
    return source.split(oldString).join(newString)
  }
  const first = source.indexOf(oldString)
  if (first === -1) throw new Error('old_string not found in file')
  const second = source.indexOf(oldString, first + oldString.length)
  if (second !== -1) {
    throw new Error(
      'old_string is not unique in the file — provide more surrounding context, or pass replace_all=true',
    )
  }
  return source.slice(0, first) + newString + source.slice(first + oldString.length)
}

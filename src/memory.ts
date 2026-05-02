/**
 * Discover and load project memory files (`AGENTS.md`).
 *
 * Walks up from cwd collecting every `AGENTS.md`, plus the user-level
 * `~/.forge/AGENTS.md`, then concatenates in nearest-first order so that
 * the most-specific project rules appear last (and therefore loudest) in
 * the system prompt.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const PROJECT_FILENAME = 'AGENTS.md'
const USER_MEMORY_PATH = '~/.forge/AGENTS.md'

export interface MemoryEntry {
  path: string
  content: string
  scope: 'user' | 'project'
  /** Last-modified time of the file when we read it. */
  mtimeMs: number
}

export interface LoadMemoryOptions {
  cwd?: string
  /** Stop walking up the tree at this directory (defaults to home). */
  ceiling?: string
  /** Maximum bytes per file to read. Larger files are truncated with a marker. */
  maxBytes?: number
}

const DEFAULT_MAX_BYTES = 256 * 1024 // 256KB

export function loadProjectMemory(
  options: LoadMemoryOptions = {},
): MemoryEntry[] {
  const cwd = options.cwd ?? process.cwd()
  const ceiling = options.ceiling ?? os.homedir()
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
  const entries: MemoryEntry[] = []

  // User-level (lowest priority — emitted first so project entries override).
  const userAbsolute = USER_MEMORY_PATH.startsWith('~/')
    ? path.join(os.homedir(), USER_MEMORY_PATH.slice(2))
    : USER_MEMORY_PATH
  const userResult = readIfExists(userAbsolute, maxBytes)
  if (userResult !== null) {
    entries.push({
      path: userAbsolute,
      content: userResult.content,
      scope: 'user',
      mtimeMs: userResult.mtimeMs,
    })
  }

  // Project hierarchy: nearest dir last (so it appears most prominently).
  const stack: MemoryEntry[] = []
  let current = path.resolve(cwd)
  while (true) {
    const candidate = path.join(current, PROJECT_FILENAME)
    const result = readIfExists(candidate, maxBytes)
    if (result !== null) {
      stack.push({
        path: candidate,
        content: result.content,
        scope: 'project',
        mtimeMs: result.mtimeMs,
      })
    }
    if (current === ceiling) break
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }

  // Stack was collected innermost-first; flip so outermost appears first
  // (project root context comes before subdir overrides).
  entries.push(...stack.reverse())
  return entries
}

function readIfExists(
  filePath: string,
  maxBytes: number,
): { content: string; mtimeMs: number } | null {
  try {
    const stat = fs.statSync(filePath)
    if (!stat.isFile()) return null
    const fd = fs.openSync(filePath, 'r')
    try {
      const buffer = Buffer.alloc(Math.min(stat.size, maxBytes))
      fs.readSync(fd, buffer, 0, buffer.length, 0)
      const truncated = stat.size > maxBytes
      const text = truncated
        ? `${buffer.toString('utf8')}\n\n[truncated: file exceeds ${maxBytes} bytes]`
        : buffer.toString('utf8')
      return { content: text, mtimeMs: stat.mtimeMs }
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    return null
  }
}

/**
 * Format a "this is a snapshot" age note for a project-memory entry. Surfacing
 * the file's age lets the model judge whether the conventions it's reading are
 * fresh (treat as authoritative) or months-old (might be stale).
 */
export function memoryFreshnessNote(mtimeMs: number, now = Date.now()): string {
  const ms = Math.max(0, now - mtimeMs)
  const day = 24 * 60 * 60 * 1000
  const days = Math.floor(ms / day)
  if (days < 1) return '(snapshot from today)'
  if (days === 1) return '(snapshot from 1 day ago)'
  if (days < 30) return `(snapshot from ${days} days ago)`
  const months = Math.floor(days / 30)
  if (months === 1) return '(snapshot from 1 month ago)'
  return `(snapshot from ${months} months ago)`
}

/**
 * Render loaded memory entries into a single block for the system prompt.
 * Each entry carries a freshness note so the model knows how old the
 * snapshot is.
 */
export function formatProjectMemory(entries: MemoryEntry[]): string {
  if (entries.length === 0) return ''
  const sections = entries.map(entry => {
    const scope = entry.scope === 'user' ? 'User' : 'Project'
    const freshness = memoryFreshnessNote(entry.mtimeMs)
    const header = `# ${scope} memory: ${entry.path} ${freshness}`
    return `${header}\n${entry.content.trim()}`
  })
  return sections.join('\n\n---\n\n')
}

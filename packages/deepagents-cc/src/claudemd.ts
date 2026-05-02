/**
 * Discover and load CLAUDE.md / AGENTS.md project memory.
 *
 * Mirrors cc's `src/utils/claudemd.ts`: walk up from cwd collecting every
 * CLAUDE.md (and AGENTS.md as fallback), plus the user-level
 * ~/.claude/CLAUDE.md, then concatenate in nearest-first order.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const PROJECT_FILENAMES = ['CLAUDE.md', 'AGENTS.md'] as const
const USER_FILENAMES = ['~/.claude/CLAUDE.md', '~/.claude-code/CLAUDE.md']

export interface ClaudeMdEntry {
  path: string
  content: string
  scope: 'user' | 'project'
}

export interface LoadClaudeMdOptions {
  cwd?: string
  /** Stop walking up the tree at this directory (defaults to home). */
  ceiling?: string
  /** Maximum bytes per file to read. Larger files are truncated with a marker. */
  maxBytes?: number
}

const DEFAULT_MAX_BYTES = 256 * 1024 // 256KB

export function loadClaudeMd(
  options: LoadClaudeMdOptions = {},
): ClaudeMdEntry[] {
  const cwd = options.cwd ?? process.cwd()
  const ceiling = options.ceiling ?? os.homedir()
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
  const entries: ClaudeMdEntry[] = []

  // User-level (lowest priority — emitted first so project entries override).
  for (const userPath of USER_FILENAMES) {
    const absolute = userPath.startsWith('~/')
      ? path.join(os.homedir(), userPath.slice(2))
      : userPath
    const content = readIfExists(absolute, maxBytes)
    if (content !== null) {
      entries.push({ path: absolute, content, scope: 'user' })
      break // Only load the first matching user file.
    }
  }

  // Project hierarchy: nearest dir last (so it appears most prominently).
  const stack: ClaudeMdEntry[] = []
  let current = path.resolve(cwd)
  while (true) {
    for (const filename of PROJECT_FILENAMES) {
      const candidate = path.join(current, filename)
      const content = readIfExists(candidate, maxBytes)
      if (content !== null) {
        stack.push({ path: candidate, content, scope: 'project' })
        break // Only one of CLAUDE.md / AGENTS.md per directory.
      }
    }
    if (current === ceiling) break
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }

  // Stack was collected innermost-first; flip so outermost appears first
  // (matches cc behavior where project root context comes before subdir).
  entries.push(...stack.reverse())
  return entries
}

function readIfExists(filePath: string, maxBytes: number): string | null {
  try {
    const stat = fs.statSync(filePath)
    if (!stat.isFile()) return null
    const fd = fs.openSync(filePath, 'r')
    try {
      const buffer = Buffer.alloc(Math.min(stat.size, maxBytes))
      fs.readSync(fd, buffer, 0, buffer.length, 0)
      const truncated = stat.size > maxBytes
      return truncated
        ? `${buffer.toString('utf8')}\n\n[truncated: file exceeds ${maxBytes} bytes]`
        : buffer.toString('utf8')
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    return null
  }
}

/**
 * Format loaded CLAUDE.md entries into a single block for the system prompt.
 */
export function formatClaudeMd(entries: ClaudeMdEntry[]): string {
  if (entries.length === 0) return ''
  const sections = entries.map(entry => {
    const header = `# ${entry.scope === 'user' ? 'User' : 'Project'} memory: ${entry.path}`
    return `${header}\n${entry.content.trim()}`
  })
  return sections.join('\n\n---\n\n')
}

/**
 * glob — find files by pattern, sorted by mtime (newest first).
 *
 * Pure-Node implementation: walks the directory tree manually instead of
 * shelling out, so it works the same on every platform without depending
 * on `find`. Supports `**`, `*`, `?`, and basic `[abc]` character classes.
 *
 * Recency-sorted because that's what cc does and what humans expect: when
 * you ask for "src/**\/*.ts", the most recently touched file is almost
 * always the one you want first.
 */

import fs from 'node:fs'
import path from 'node:path'
import { tool } from 'langchain'
import { z } from 'zod/v4'
import { ensureAbsolute } from './fsUtils.js'
import { globToRegex } from './globRegex.js'

export { globToRegex }

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.next',
  '.turbo',
  '.cache',
  'dist',
  'build',
  '.venv',
  '__pycache__',
])

const schema = z.object({
  pattern: z.string().describe('Glob pattern. Examples: "src/**/*.ts", "*.md", "**/Dockerfile".'),
  path: z
    .string()
    .optional()
    .describe('Absolute directory to search from. Defaults to the agent cwd.'),
  limit: z
    .number()
    .int()
    .positive()
    .max(1000)
    .optional()
    .describe('Max results (default 100). Newest-first.'),
})

const description = `Find files matching a glob pattern, sorted by modification time (newest first).

Patterns:
 - **    matches any number of directories
 - *     matches any chars except /
 - ?     matches one char
 - [abc] matches one of a, b, or c

Auto-skips node_modules, .git, dist, build, .next, .cache, .turbo, .venv, __pycache__.`

export interface GlobToolOptions {
  cwd?: string
}

export function createGlobTool(options: GlobToolOptions = {}) {
  return tool(
    (input: z.infer<typeof schema>) => {
      const root = ensureAbsolute(input.path ?? options.cwd ?? process.cwd(), 'path')
      const limit = input.limit ?? 100
      const re = globToRegex(input.pattern)
      const matches: Array<{ p: string; m: number }> = []
      walk(root, root, re, matches, limit * 4) // gather extra so mtime sort is meaningful
      matches.sort((a, b) => b.m - a.m)
      const top = matches.slice(0, limit)
      if (top.length === 0) return `(no matches for "${input.pattern}" in ${root})`
      const tail =
        matches.length > limit ? `\n\n[showed ${limit} of ${matches.length}+ matches]` : ''
      return top.map(x => x.p).join('\n') + tail
    },
    { name: 'glob', description, schema },
  )
}

/**
 * Recursive walker. Stops collecting when `cap` is reached (we still
 * descend the rest of the tree because skipping early would make sort
 * order non-deterministic).
 */
function walk(
  dir: string,
  root: string,
  re: RegExp,
  out: Array<{ p: string; m: number }>,
  cap: number,
): void {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (out.length >= cap) return
    if (entry.name.startsWith('.') && entry.name !== '.') continue
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      walk(path.join(dir, entry.name), root, re, out, cap)
    } else if (entry.isFile()) {
      const full = path.join(dir, entry.name)
      const rel = path.relative(root, full)
      if (re.test(rel)) {
        try {
          const stat = fs.statSync(full)
          out.push({ p: full, m: stat.mtimeMs })
        } catch {
          // file vanished between readdir and stat — skip
        }
      }
    }
  }
}


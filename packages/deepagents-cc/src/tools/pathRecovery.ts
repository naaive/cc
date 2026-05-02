/**
 * Path-recovery helpers — surface "did you mean ...?" hints when a tool
 * call references a non-existent path.
 *
 * cc's flow:
 *   - Read /missing/file.ts → file doesn't exist
 *   - Don't just say "ENOENT" — scan the parent directory for a file
 *     with a similar name (Levenshtein distance ≤ 3) and suggest it.
 *   - If the path looks like it might be relative (user typo), look for
 *     a matching basename anywhere under cwd and suggest it too.
 *
 * These are pure helpers, called from Read / Write / Edit when statSync
 * throws ENOENT.
 */

import fs from 'node:fs'
import path from 'node:path'
import { DEFAULT_SKIP_DIRS } from './fsUtils.js'

const SKIP_DIRS = DEFAULT_SKIP_DIRS
const MAX_WALK_DEPTH = 8

/**
 * Find a file in `dir` with a name similar to `target` (case-insensitive
 * Levenshtein ≤ 3, plus prefix/suffix shortcut).
 */
export function findSimilarFile(
  absoluteMissingPath: string,
  maxDistance = 3,
): string | null {
  const dir = path.dirname(absoluteMissingPath)
  const target = path.basename(absoluteMissingPath).toLowerCase()
  let entries: string[]
  try {
    entries = fs.readdirSync(dir)
  } catch {
    return null
  }
  let best: { name: string; distance: number } | null = null
  for (const name of entries) {
    const lower = name.toLowerCase()
    if (lower === target) return path.join(dir, name) // case-only mismatch
    const d = levenshtein(lower, target)
    if (d > maxDistance) continue
    if (best === null || d < best.distance) {
      best = { name, distance: d }
    }
  }
  return best ? path.join(dir, best.name) : null
}

/**
 * Walk the tree under `cwd` looking for a file whose basename matches
 * the missing path's basename. Useful when the model gives a relative-
 * looking path that happens to be wrong only in its directory portion.
 */
export function suggestPathUnderCwd(
  cwd: string,
  missing: string,
  maxResults = 5,
): string[] {
  const target = path.basename(missing).toLowerCase()
  if (target.length === 0) return []
  const matches: string[] = []
  walk(cwd, target, matches, maxResults, 0)
  return matches
}

function walk(
  dir: string,
  target: string,
  out: string[],
  cap: number,
  depth: number,
): void {
  if (out.length >= cap || depth > MAX_WALK_DEPTH) return
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (out.length >= cap) return
    if (entry.name.startsWith('.')) continue
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      walk(path.join(dir, entry.name), target, out, cap, depth + 1)
    } else if (entry.isFile() && entry.name.toLowerCase() === target) {
      out.push(path.join(dir, entry.name))
    }
  }
}

/** Format a "Did you mean…?" hint for a missing-path error. */
export function pathRecoveryHint(
  missing: string,
  cwd: string,
): string | null {
  const similar = findSimilarFile(missing)
  const suggestions = suggestPathUnderCwd(cwd, missing, 3)
  const lines: string[] = []
  if (similar) lines.push(`  - ${similar}`)
  for (const s of suggestions) {
    if (s !== similar) lines.push(`  - ${s}`)
  }
  if (lines.length === 0) return null
  return `Did you mean one of these?\n${lines.join('\n')}`
}

/**
 * Levenshtein edit distance, clamped at `cap` for early exit.
 */
export function levenshtein(a: string, b: string, cap = 4): number {
  if (a === b) return 0
  if (Math.abs(a.length - b.length) > cap) return cap + 1
  // Two-row DP, O(min(a,b)) memory.
  let prev = new Array(b.length + 1).fill(0).map((_, i) => i)
  let curr = new Array(b.length + 1).fill(0)
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i
    let rowMin = i
    for (let j = 1; j <= b.length; j++) {
      curr[j] = Math.min(
        curr[j - 1] + 1,
        prev[j] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      )
      if (curr[j] < rowMin) rowMin = curr[j]
    }
    if (rowMin > cap) return cap + 1
    ;[prev, curr] = [curr, prev]
  }
  return prev[b.length]!
}

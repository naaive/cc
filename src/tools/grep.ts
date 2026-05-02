/**
 * grep — content search.
 *
 * We use ripgrep when available; we follow that lead with a graceful
 * fallback to a pure-Node walker so users on minimal images still get
 * something. The fallback is slower but matches the same regex syntax
 * (JavaScript regex, since that's what we hand to RegExp).
 *
 * Output formats: "files" (paths only, recency-sorted), "matches"
 * (path:line:content). Defaults to files because it's almost always what
 * the model wants — followed by a targeted read_file.
 */

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { tool } from 'langchain'
import { z } from 'zod/v4'
import { TOOL_DESCRIPTIONS, TOOL_NAMES } from './toolNames.js'
import { DEFAULT_SKIP_DIRS, ensureAbsolute, isBinaryFile, truncateLine } from './fsUtils.js'

const SKIP_DIRS = DEFAULT_SKIP_DIRS

const schema = z.object({
  pattern: z.string().describe('Regex pattern (ripgrep syntax). JavaScript-style; use \\\\ to escape backslashes in JSON.'),
  path: z
    .string()
    .optional()
    .describe('Absolute directory to search from. Defaults to the agent cwd.'),
  glob: z
    .string()
    .optional()
    .describe('Optional glob filter on file path, e.g. "**/*.ts".'),
  output_mode: z
    .enum(['content', 'files_with_matches', 'count'])
    .optional()
    .describe('"content" shows matching lines, "files_with_matches" shows paths only (default), "count" shows match counts.'),
  '-i': z.boolean().optional().describe('Case-insensitive search.'),
  multiline: z
    .boolean()
    .optional()
    .describe('Allow . to match newlines. Use for cross-line patterns.'),
  head_limit: z
    .number()
    .int()
    .positive()
    .max(2000)
    .optional()
    .describe('Max lines/files in the result (default 200).'),
})

export interface GrepToolOptions {
  cwd?: string
  /** Override ripgrep detection (useful for tests). */
  forceFallback?: boolean
}

export function createGrepTool(options: GrepToolOptions = {}) {
  return tool(
    (input: z.infer<typeof schema>) => {
      const root = ensureAbsolute(input.path ?? options.cwd ?? process.cwd(), 'path')
      const limit = input.head_limit ?? 200
      const mode = input.output_mode ?? 'files_with_matches'

      if (!options.forceFallback && !input.multiline && hasRipgrep()) {
        const out = runRipgrep(root, input, mode, limit)
        if (out !== null) return out
      }
      return walkFallback(root, input, mode, limit)
    },
    {
      name: TOOL_NAMES.Grep,
      description: TOOL_DESCRIPTIONS.Grep,
      schema,
    },
  )
}

let _ripgrepCached: boolean | null = null
function hasRipgrep(): boolean {
  if (_ripgrepCached !== null) return _ripgrepCached
  try {
    const r = spawnSync('rg', ['--version'], { stdio: ['ignore', 'pipe', 'ignore'] })
    _ripgrepCached = r.status === 0
  } catch {
    _ripgrepCached = false
  }
  return _ripgrepCached
}

type GrepMode = 'content' | 'files_with_matches' | 'count'

function runRipgrep(
  root: string,
  input: z.infer<typeof schema>,
  mode: GrepMode,
  limit: number,
): string | null {
  const args: string[] = ['--no-config']
  if (input['-i']) args.push('-i')
  if (mode === 'files_with_matches') args.push('-l')
  else if (mode === 'count') args.push('-c')
  else args.push('-n')
  if (input.glob) args.push('-g', input.glob)
  args.push('--', input.pattern, root)
  const res = spawnSync('rg', args, { encoding: 'utf8' })
  if (res.error) return null
  if (res.status === 1) return `(no matches for /${input.pattern}/ in ${root})`
  if (res.status !== 0) return null
  const lines = (res.stdout ?? '').split('\n').filter(Boolean)
  const top = lines.slice(0, limit)
  const tail =
    lines.length > limit ? `\n\n[showed ${limit} of ${lines.length}+ results]` : ''
  return top.join('\n') + tail
}

function walkFallback(
  root: string,
  input: z.infer<typeof schema>,
  mode: GrepMode,
  limit: number,
): string {
  const flags = `${input['-i'] ? 'i' : ''}${input.multiline ? 's' : ''}`
  let re: RegExp
  try {
    re = new RegExp(input.pattern, flags)
  } catch (err) {
    return `invalid regex: ${(err as Error).message}`
  }
  const filterRe = input.glob ? globFilterToRegex(input.glob) : null
  const matchedFiles: string[] = []
  const matchedLines: string[] = []
  const counts = new Map<string, number>()

  const visit = (dir: string) => {
    if (matchedLines.length >= limit && matchedFiles.length >= limit) return
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue
        visit(path.join(dir, entry.name))
      } else if (entry.isFile()) {
        const full = path.join(dir, entry.name)
        if (filterRe && !filterRe.test(path.relative(root, full))) continue
        if (isBinaryFile(full)) continue
        let content: string
        try {
          content = fs.readFileSync(full, 'utf8')
        } catch {
          continue
        }
        if (input.multiline) {
          if (re.test(content)) {
            matchedFiles.push(full)
            if (mode === 'content') matchedLines.push(`${full}: <multiline match>`)
            else if (mode === 'count') counts.set(full, (counts.get(full) ?? 0) + 1)
          }
        } else {
          const lines = content.split('\n')
          let fileMatched = false
          let fileCount = 0
          for (let i = 0; i < lines.length; i++) {
            re.lastIndex = 0
            if (re.test(lines[i]!)) {
              fileMatched = true
              fileCount++
              if (mode === 'content') {
                matchedLines.push(`${full}:${i + 1}:${truncateLine(lines[i]!)}`)
                if (matchedLines.length >= limit) return
              } else if (mode === 'files_with_matches') {
                break
              }
            }
          }
          if (fileMatched) {
            if (mode === 'files_with_matches') {
              matchedFiles.push(full)
              if (matchedFiles.length >= limit) return
            } else if (mode === 'count') {
              counts.set(full, fileCount)
            }
          }
        }
      }
    }
  }

  visit(root)

  if (mode === 'files_with_matches') {
    if (matchedFiles.length === 0) return `(no matches for /${input.pattern}/ in ${root})`
    return matchedFiles.join('\n')
  }
  if (mode === 'count') {
    if (counts.size === 0) return `(no matches for /${input.pattern}/ in ${root})`
    return [...counts.entries()].map(([f, n]) => `${f}:${n}`).join('\n')
  }
  if (matchedLines.length === 0) return `(no matches for /${input.pattern}/ in ${root})`
  return matchedLines.join('\n')
}

function globFilterToRegex(pattern: string): RegExp {
  // Tiny glob → regex; only covers the common forms used as `--glob`.
  let out = ''
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        out += '.*'
        i++
      } else {
        out += '[^/]*'
      }
    } else if (ch === '?') {
      out += '[^/]'
    } else if ('\\^$.|+(){}[]'.includes(ch)) {
      out += `\\${ch}`
    } else {
      out += ch
    }
  }
  return new RegExp(`(?:^|/)${out}$`)
}

/** Test seam: forget cached ripgrep detection. */
export function _resetRipgrepCache(): void {
  _ripgrepCached = null
}

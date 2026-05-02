/**
 * Custom-command expander.
 *
 * Walks the command body, performing the three substitutions cc supports:
 *
 *  - `$ARGUMENTS`        →  caller-supplied args (one string).
 *  - `!<bash command>`   →  run the bash command, inline its stdout.
 *                           Only matches lines whose first non-whitespace
 *                           character is `!` (so prose using `!` is safe).
 *  - `@<path>`           →  read file at <path> and inline its content.
 *                           Path is resolved relative to `cwd` when not
 *                           absolute. Failures inline a `[error: ...]` stub
 *                           instead of throwing.
 *
 * The substitutions run in order: $ARGUMENTS first (so an `$ARGUMENTS`
 * containing a bash command stays literal), then bash lines, then @file.
 *
 * `!` and `@` substitutions are I/O — they take an injectable
 * `runBash` / `readFile` so tests can stub them and the agent can plug
 * in its `PersistentShell` for cwd consistency.
 */

import fs from 'node:fs'
import path from 'node:path'

export interface ExpanderOptions {
  cwd: string
  /** Run a bash command, return stdout. Default: child_process.spawnSync. */
  runBash?: (command: string) => Promise<string> | string
  /** Read a file. Default: fs.readFileSync (utf8). */
  readFile?: (absPath: string) => Promise<string> | string
  /** Cap inlined file/bash output (chars) to keep prompts sane. Default 8000. */
  maxInlineChars?: number
}

export async function expandCommandBody(
  body: string,
  args: string,
  options: ExpanderOptions,
): Promise<string> {
  const cap = options.maxInlineChars ?? 8000

  // 1. $ARGUMENTS — straight literal substitution.
  let out = body.split('$ARGUMENTS').join(args)

  // 2. `!`-prefixed lines → bash. Walk line by line so we can replace each
  //    in place. An empty `!` (just "!") inlines an empty string.
  out = await replaceLines(out, async line => {
    const trimmed = line.trimStart()
    if (!trimmed.startsWith('!')) return line
    const command = trimmed.slice(1).trim()
    if (!command) return ''
    try {
      const result = await runBash(command, options)
      return capInline(result.trimEnd(), cap)
    } catch (err) {
      return `[error running !${command}: ${(err as Error).message}]`
    }
  })

  // 3. @<path> references. We match `@` followed by a non-whitespace path
  //    that doesn't start with `:` (to avoid eating `@user@host:path`-style
  //    addresses). Path can be quoted to include spaces.
  out = await replaceAsync(
    out,
    /@(?:"([^"]+)"|'([^']+)'|([^\s'"@,;]+))/g,
    async (_, dq, sq, raw) => {
      const ref = (dq ?? sq ?? raw) as string
      try {
        const abs = path.isAbsolute(ref) ? ref : path.resolve(options.cwd, ref)
        const content = await readFile(abs, options)
        return capInline(content, cap)
      } catch (err) {
        return `[error reading @${ref}: ${(err as Error).message}]`
      }
    },
  )

  return out
}

async function runBash(command: string, options: ExpanderOptions): Promise<string> {
  if (options.runBash) return await options.runBash(command)
  // Lazy require to dodge a top-level node:child_process import — keeps the
  // pure file pure-ish for easier sandbox testing.
  const { spawnSync } = await import('node:child_process')
  const r = spawnSync('/bin/sh', ['-c', command], {
    cwd: options.cwd,
    encoding: 'utf8',
  })
  return r.stdout ?? ''
}

async function readFile(absPath: string, options: ExpanderOptions): Promise<string> {
  if (options.readFile) return await options.readFile(absPath)
  return fs.readFileSync(absPath, 'utf8')
}

function capInline(text: string, cap: number): string {
  if (text.length <= cap) return text
  return `${text.slice(0, cap)}\n[... truncated to ${cap} chars]`
}

async function replaceLines(
  text: string,
  fn: (line: string) => Promise<string> | string,
): Promise<string> {
  const lines = text.split('\n')
  const out: string[] = []
  for (const line of lines) out.push(await fn(line))
  return out.join('\n')
}

async function replaceAsync(
  text: string,
  pattern: RegExp,
  replacer: (match: string, ...groups: unknown[]) => Promise<string> | string,
): Promise<string> {
  const matches: Array<{ start: number; end: number; replacement: string }> = []
  for (const m of text.matchAll(pattern)) {
    const replacement = await replacer(m[0], ...m.slice(1))
    matches.push({
      start: m.index ?? 0,
      end: (m.index ?? 0) + m[0].length,
      replacement,
    })
  }
  if (matches.length === 0) return text
  let result = ''
  let cursor = 0
  for (const m of matches) {
    result += text.slice(cursor, m.start) + m.replacement
    cursor = m.end
  }
  result += text.slice(cursor)
  return result
}

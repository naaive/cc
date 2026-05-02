/**
 * Glob → regex converter. Memoised because every fs walker, the permission-
 * rule evaluator, and the skill activator hit it on every tool call.
 *
 * Supports the patterns we actually use: `**`, `*`, `?`, `[abc]`.
 *  - `**` matches any depth.
 *  - `*`  matches one segment (does NOT cross `/`).
 *  - `?`  matches a single non-`/` char.
 *  - `[abc]` and `[a-z]` character classes pass through verbatim.
 */

const cache = new Map<string, RegExp>()

export function globToRegex(pattern: string): RegExp {
  const cached = cache.get(pattern)
  if (cached) return cached
  const re = compile(pattern)
  cache.set(pattern, re)
  return re
}

function compile(pattern: string): RegExp {
  let i = 0
  let out = ''
  while (i < pattern.length) {
    const ch = pattern[i]!
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        if (pattern[i + 2] === '/') {
          out += '(?:.*/)?'
          i += 3
        } else {
          out += '.*'
          i += 2
        }
        continue
      }
      out += '[^/]*'
      i++
      continue
    }
    if (ch === '?') {
      out += '[^/]'
      i++
      continue
    }
    if (ch === '[') {
      const close = pattern.indexOf(']', i)
      if (close === -1) {
        out += '\\['
        i++
        continue
      }
      out += pattern.slice(i, close + 1)
      i = close + 1
      continue
    }
    if ('\\^$.|+(){}'.includes(ch)) {
      out += `\\${ch}`
    } else {
      out += ch
    }
    i++
  }
  return new RegExp(`^${out}$`)
}

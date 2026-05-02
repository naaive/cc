/**
 * YAML frontmatter — the minimum subset needed by SKILL.md / .forge command
 * files.
 *
 * Both formats use a flat `key: value` block fenced by `---` lines, so we
 * intentionally avoid a real YAML dependency: the parser handles only what
 * the formats actually allow (string scalars, optional surrounding quotes).
 *
 * `parseFrontmatter` returns the fields and the body in one pass so callers
 * don't run the regex twice.
 */

const FRONTMATTER_PATTERN = /^---\s*\n([\s\S]*?)\n---\s*\n/

export interface Frontmatter {
  fields: Record<string, string>
  /** Body text (everything after the closing `---`). Empty when no frontmatter. */
  body: string
  /** True when the document started with a `---` block. */
  hasFrontmatter: boolean
}

export function parseFrontmatter(source: string): Frontmatter {
  const match = source.match(FRONTMATTER_PATTERN)
  if (!match) return { fields: {}, body: source, hasFrontmatter: false }
  return {
    fields: parseFlatYaml(match[1]!),
    body: source.slice(match[0].length),
    hasFrontmatter: true,
  }
}

export function parseFlatYaml(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const colon = trimmed.indexOf(':')
    if (colon < 0) continue
    const key = trimmed.slice(0, colon).trim()
    let value = trimmed.slice(colon + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    out[key] = value
  }
  return out
}

/**
 * Shared primitives for "discoverable file-backed modules" — the pattern
 * Skills and Commands both follow:
 *
 *  - One markdown file per module.
 *  - Optional/required YAML frontmatter (name, description, …).
 *  - Loaded from one or more directories (user, project).
 *  - Project entries shadow user entries with the same name.
 *  - Body is loaded eagerly (commands) or lazily (skills).
 *
 * Skills walk `<dir>/<name>/SKILL.md`; Commands walk `<dir>/**\/*.md` with
 * folder paths becoming `:`-separated namespaces. The walker stays
 * loader-specific because the directory shapes are genuinely different,
 * but the size cap, frontmatter parse, and dedup-by-name rule are shared
 * here so a fix to either lands once.
 */

import fs from 'node:fs'

/** 10MB cap — generous; protects against accidental binary-in-the-dir. */
export const MAX_MODULE_FILE_SIZE = 10 * 1024 * 1024

export type ModuleSource = 'user' | 'project' | 'inline'

/** The minimum surface every discoverable module presents. */
export interface DiscoverableModule {
  name: string
  source: ModuleSource
  /** Absolute path to the file. */
  path: string
}

/**
 * Read a module file with a size cap. Returns null on too-big or
 * unreadable — callers treat null as "skip this entry, don't crash".
 */
export function readModuleSource(filePath: string): string | null {
  try {
    const stat = fs.statSync(filePath)
    if (stat.size > MAX_MODULE_FILE_SIZE) return null
    return fs.readFileSync(filePath, 'utf8')
  } catch {
    return null
  }
}

/**
 * Project entries (later in the input list) shadow user entries. Returns
 * the deduplicated list sorted by name. Generic over any module subtype.
 */
export function dedupeByName<T extends { name: string }>(items: readonly T[]): T[] {
  const map = new Map<string, T>()
  for (const item of items) map.set(item.name, item)
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name))
}

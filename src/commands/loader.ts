/**
 * Custom commands loader — `.forge/commands/` convention.
 *
 * Each command is a `.md` file with optional YAML frontmatter and a body
 * that's a prompt template. The body supports three substitutions:
 *
 *  - `$ARGUMENTS` — replaced with whatever the caller passed as args.
 *  - lines starting with `!` — the rest of the line is run as a bash
 *    command and its stdout is inlined where the line was.
 *  - `@<path>` — replaced with the contents of the file at `<path>`
 *    (resolved relative to the command's project root or absolute).
 *
 * Frontmatter (all optional):
 *
 *   ---
 *   description: One-line summary shown in pickers.
 *   argument-hint: "<file_path>"
 *   allowed-tools: "Read Edit Bash"
 *   model: claude-opus-4-7
 *   ---
 *
 * Layout:
 *
 *   <repo>/.forge/commands/lint.md          → /lint
 *   <repo>/.forge/commands/git/commit.md    → /git:commit  (folder = namespace)
 *   ~/.forge/commands/init.md               → /init        (user-level)
 *
 * Project commands shadow user commands when names collide.
 */

import fs from 'node:fs'
import path from 'node:path'

export const MAX_COMMAND_FILE_SIZE = 10 * 1024 * 1024
const FRONTMATTER_PATTERN = /^---\s*\n([\s\S]*?)\n---\s*\n/
// Must start with a letter (to disambiguate from numeric prefixes that
// usually indicate accidental file names). Same lower-kebab convention
// as the Skills spec.
const COMMAND_NAME_PATTERN = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/

export interface CustomCommand {
  /** Slash name without leading "/". Folder paths use ":" as separator. */
  name: string
  description?: string
  argumentHint?: string
  /** Whitespace-separated tool names this command is allowed to use. */
  allowedTools?: string
  model?: string
  /** Raw body (template) as written in the .md file, sans frontmatter. */
  body: string
  source: 'user' | 'project'
  /** Absolute path to the command's .md file. */
  path: string
}

export interface ListCommandsOptions {
  userCommandsDir?: string | null
  projectCommandsDir?: string | null
}

export function listCommands(options: ListCommandsOptions): CustomCommand[] {
  const out: CustomCommand[] = []
  if (options.userCommandsDir) out.push(...readDir(options.userCommandsDir, 'user'))
  if (options.projectCommandsDir)
    out.push(...readDir(options.projectCommandsDir, 'project'))
  return dedupeByName(out)
}

function readDir(rootDir: string, source: 'user' | 'project'): CustomCommand[] {
  if (!fs.existsSync(rootDir)) return []
  const out: CustomCommand[] = []
  walk(rootDir, [], out, source)
  return out
}

function walk(
  dir: string,
  segments: string[],
  out: CustomCommand[],
  source: 'user' | 'project',
): void {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      walk(full, [...segments, entry.name], out, source)
      continue
    }
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue
    const baseName = entry.name.slice(0, -3) // strip .md
    const cmd = parseCommandFile(full, [...segments, baseName].join(':'), source)
    if (cmd) out.push(cmd)
  }
}

function dedupeByName(cmds: CustomCommand[]): CustomCommand[] {
  // Project (later in the list) shadows user.
  const map = new Map<string, CustomCommand>()
  for (const c of cmds) map.set(c.name, c)
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name))
}

export function parseCommandFile(
  filePath: string,
  name: string,
  source: 'user' | 'project',
): CustomCommand | null {
  if (!isValidCommandName(name)) return null
  let raw: string
  try {
    const stat = fs.statSync(filePath)
    if (stat.size > MAX_COMMAND_FILE_SIZE) return null
    raw = fs.readFileSync(filePath, 'utf8')
  } catch {
    return null
  }
  const fmMatch = raw.match(FRONTMATTER_PATTERN)
  const body = fmMatch ? raw.slice(fmMatch[0].length) : raw
  const fm = fmMatch ? parseSimpleYaml(fmMatch[1]!) : {}
  const cmd: CustomCommand = {
    name,
    body,
    source,
    path: filePath,
  }
  if (typeof fm['description'] === 'string') cmd.description = fm['description']
  if (typeof fm['argument-hint'] === 'string') cmd.argumentHint = fm['argument-hint']
  if (typeof fm['allowed-tools'] === 'string') cmd.allowedTools = fm['allowed-tools']
  if (typeof fm['model'] === 'string') cmd.model = fm['model']
  return cmd
}

function isValidCommandName(name: string): boolean {
  if (!name) return false
  // Allow ":" to separate namespaces; each segment must match the pattern.
  return name.split(':').every(seg => COMMAND_NAME_PATTERN.test(seg))
}

/** Tiny YAML subset parser (key: value lines only — same as skills loader). */
function parseSimpleYaml(text: string): Record<string, string> {
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

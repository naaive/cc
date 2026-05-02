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
import { parseFrontmatter } from '../lib/yamlFrontmatter.js'
import {
  dedupeByName,
  MAX_MODULE_FILE_SIZE,
  readModuleSource,
  type DiscoverableModule,
} from '../lib/discoverableModule.js'

export const MAX_COMMAND_FILE_SIZE = MAX_MODULE_FILE_SIZE
// Must start with a letter (to disambiguate from numeric prefixes that
// usually indicate accidental file names). Same lower-kebab convention
// as the Skills spec.
const COMMAND_NAME_PATTERN = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/

export interface CustomCommand extends DiscoverableModule {
  /** Slash name without leading "/". Folder paths use ":" as separator. */
  description?: string
  argumentHint?: string
  /** Whitespace-separated tool names this command is allowed to use. */
  allowedTools?: string
  model?: string
  /** Raw body (template) as written in the .md file, sans frontmatter. */
  body: string
  /**
   * Commands always come from disk (no inline mode), but the wider
   * DiscoverableModule shape allows 'inline' too — narrow it here.
   */
  source: 'user' | 'project'
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

export function parseCommandFile(
  filePath: string,
  name: string,
  source: 'user' | 'project',
): CustomCommand | null {
  if (!isValidCommandName(name)) return null
  const raw = readModuleSource(filePath)
  if (raw === null) return null
  const { fields, body } = parseFrontmatter(raw)
  const cmd: CustomCommand = {
    name,
    body,
    source,
    path: filePath,
  }
  if (typeof fields['description'] === 'string') cmd.description = fields['description']
  if (typeof fields['argument-hint'] === 'string') cmd.argumentHint = fields['argument-hint']
  if (typeof fields['allowed-tools'] === 'string') cmd.allowedTools = fields['allowed-tools']
  if (typeof fields['model'] === 'string') cmd.model = fields['model']
  return cmd
}

function isValidCommandName(name: string): boolean {
  if (!name) return false
  // Allow ":" to separate namespaces; each segment must match the pattern.
  return name.split(':').every(seg => COMMAND_NAME_PATTERN.test(seg))
}

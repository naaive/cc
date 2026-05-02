/**
 * SKILL.md loader (Anthropic Agent Skills format).
 *
 * A skill is a directory containing a `SKILL.md` file. The file starts
 * with YAML frontmatter (`name`, `description` required; optional
 * `license`, `compatibility`, `allowedTools`, custom metadata) followed
 * by markdown instructions.
 *
 * On load we read frontmatter only (cheap, fits in 4KB) and stash the
 * full path; the body is read on demand via the `Skill` tool. This is
 * what keeps Skills cheap context-wise: thousands of skills can be
 * installed without bloating the system prompt.
 *
 * @see https://agentskills.io/specification
 */

import fs from 'node:fs'
import path from 'node:path'
import { parseFrontmatter } from '../lib/yamlFrontmatter.js'

export const MAX_SKILL_FILE_SIZE = 10 * 1024 * 1024
export const MAX_SKILL_NAME_LENGTH = 64
export const MAX_SKILL_DESCRIPTION_LENGTH = 1024

const SKILL_NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/

export interface SkillMetadata {
  name: string
  description: string
  /** Absolute path to the SKILL.md file. */
  path: string
  source: 'user' | 'project' | 'inline'
  license?: string
  compatibility?: string
  allowedTools?: string
  /** Glob patterns that, when matched by a Read, auto-activate this skill. */
  activatePaths?: string[]
  metadata?: Record<string, string>
}

export interface ListSkillsOptions {
  userSkillsDir?: string | null
  projectSkillsDir?: string | null
}

/**
 * Walk both skill dirs and return parsed metadata. Skills with malformed
 * frontmatter or invalid names are skipped silently — we never want a
 * single bad skill to take down the whole loader.
 */
export function listSkills(options: ListSkillsOptions): SkillMetadata[] {
  const out: SkillMetadata[] = []
  if (options.userSkillsDir) {
    out.push(...readSkillDir(options.userSkillsDir, 'user'))
  }
  if (options.projectSkillsDir) {
    out.push(...readSkillDir(options.projectSkillsDir, 'project'))
  }
  // Project overrides user when names collide.
  return dedupeByName(out)
}

function readSkillDir(
  dir: string,
  source: 'user' | 'project',
): SkillMetadata[] {
  if (!fs.existsSync(dir)) return []
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const out: SkillMetadata[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const skillFile = path.join(dir, entry.name, 'SKILL.md')
    if (!fs.existsSync(skillFile)) continue
    const meta = parseSkillFile(skillFile, source)
    if (meta) out.push(meta)
  }
  return out
}

function dedupeByName(skills: SkillMetadata[]): SkillMetadata[] {
  // Project sources later in the list will overwrite user sources earlier,
  // preserving the contract (project skills shadow user skills with same name).
  const map = new Map<string, SkillMetadata>()
  for (const s of skills) {
    map.set(s.name, s)
  }
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name))
}

export function parseSkillFile(
  filePath: string,
  source: 'user' | 'project',
): SkillMetadata | null {
  let raw: string
  try {
    const stat = fs.statSync(filePath)
    if (stat.size > MAX_SKILL_FILE_SIZE) return null
    raw = fs.readFileSync(filePath, 'utf8')
  } catch {
    return null
  }
  return parseSkillMetadata(raw, filePath, source)
}

export function parseSkillMetadata(
  raw: string,
  filePath: string,
  source: 'user' | 'project' | 'inline',
): SkillMetadata | null {
  const fm = parseFrontmatter(raw)
  if (!fm.hasFrontmatter) return null
  const { fields } = fm
  const name = fields.name
  const description = fields.description
  if (typeof name !== 'string' || typeof description !== 'string') return null
  if (name.length > MAX_SKILL_NAME_LENGTH) return null
  if (description.length > MAX_SKILL_DESCRIPTION_LENGTH) return null
  if (!SKILL_NAME_PATTERN.test(name)) return null
  const out: SkillMetadata = {
    name,
    description,
    path: filePath,
    source,
  }
  if (typeof fields.license === 'string') out.license = fields.license
  if (typeof fields.compatibility === 'string') out.compatibility = fields.compatibility
  if (typeof fields['allowed-tools'] === 'string')
    out.allowedTools = fields['allowed-tools']
  // Conditional activation: a comma-separated list of glob patterns. When
  // the agent reads a file matching any pattern, the skill body is queued
  // as a system reminder for the next turn (by design).
  if (typeof fields['activate-paths'] === 'string') {
    out.activatePaths = fields['activate-paths']
      .split(',')
      .map(s => s.trim())
      .filter(Boolean)
  }
  return out
}

/**
 * Read a SKILL.md's body (everything after the frontmatter). This is the
 * payload the `Skill` tool returns to the model when invoked by name.
 */
export function readSkillBody(filePath: string): string {
  const raw = fs.readFileSync(filePath, 'utf8')
  return parseFrontmatter(raw).body.trimStart()
}

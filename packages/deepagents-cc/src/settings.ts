/**
 * Settings loader — cc's `.claude/settings.json` hierarchy.
 *
 * Precedence (later overrides earlier):
 *   1. `~/.claude/settings.json`              (user)
 *   2. `<projectRoot>/.claude/settings.json`  (project)
 *   3. `<projectRoot>/.claude/settings.local.json` (local, gitignored)
 *
 * Anything past JSON parse failure is a warning, not a hard error: the
 * harness should always boot, even when the user's config is malformed.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { HookConfig } from './middleware/hooks.js'
import type { PermissionMode } from './permissionMode.js'

export interface Settings {
  /** Default model id. */
  model?: string
  /** Initial permission mode. */
  permissionMode?: PermissionMode
  /** Allowed tool names. When set, every tool must be on this list. */
  allowedTools?: string[]
  /** Denied tool names. */
  deniedTools?: string[]
  /** Bash command allow patterns (substring match). */
  bashAllow?: string[]
  /** Bash command deny patterns (substring match). */
  bashDeny?: string[]
  /** Web fetch allow-host suffixes. */
  webFetchAllowHosts?: string[]
  /** Hook configuration. Only inline functions are skipped at load time. */
  hooks?: HookConfig
  /** Custom env vars exported into the agent's process.env at boot. */
  env?: Record<string, string>
  /** Free-form key-value bag for plugins. */
  extras?: Record<string, unknown>
}

export interface LoadSettingsOptions {
  cwd?: string
  /** Override the user dir (~/.claude). */
  userDir?: string
}

export interface LoadedSettings {
  merged: Settings
  sources: Array<{ scope: 'user' | 'project' | 'local'; path: string }>
  warnings: string[]
}

export function loadSettings(options: LoadSettingsOptions = {}): LoadedSettings {
  const cwd = options.cwd ?? process.cwd()
  const userDir = options.userDir ?? path.join(os.homedir(), '.claude')
  const projectRoot = findProjectRoot(cwd) ?? cwd

  const candidates: Array<{
    scope: 'user' | 'project' | 'local'
    path: string
  }> = [
    { scope: 'user', path: path.join(userDir, 'settings.json') },
    { scope: 'project', path: path.join(projectRoot, '.claude', 'settings.json') },
    { scope: 'local', path: path.join(projectRoot, '.claude', 'settings.local.json') },
  ]

  const sources: LoadedSettings['sources'] = []
  const warnings: string[] = []
  let merged: Settings = {}

  for (const candidate of candidates) {
    if (!fs.existsSync(candidate.path)) continue
    try {
      const raw = fs.readFileSync(candidate.path, 'utf8')
      const parsed = JSON.parse(raw) as Settings
      merged = mergeSettings(merged, parsed)
      sources.push(candidate)
    } catch (err) {
      warnings.push(`Failed to load ${candidate.path}: ${(err as Error).message}`)
    }
  }

  // Apply env vars opportunistically — process.env is process-global, but
  // we never overwrite values the user already set.
  if (merged.env) {
    for (const [key, value] of Object.entries(merged.env)) {
      if (!(key in process.env)) process.env[key] = value
    }
  }

  return { merged, sources, warnings }
}

function findProjectRoot(start: string): string | null {
  let current = path.resolve(start)
  while (true) {
    if (fs.existsSync(path.join(current, '.git'))) return current
    const parent = path.dirname(current)
    if (parent === current) return null
    current = parent
  }
}

/**
 * Shallow merge with array-concatenation semantics for tool lists/hooks.
 * Last writer wins for scalars; arrays/dicts are unioned/spread.
 */
export function mergeSettings(a: Settings, b: Settings): Settings {
  return {
    ...a,
    ...b,
    allowedTools: mergeArrays(a.allowedTools, b.allowedTools),
    deniedTools: mergeArrays(a.deniedTools, b.deniedTools),
    bashAllow: mergeArrays(a.bashAllow, b.bashAllow),
    bashDeny: mergeArrays(a.bashDeny, b.bashDeny),
    webFetchAllowHosts: mergeArrays(a.webFetchAllowHosts, b.webFetchAllowHosts),
    hooks: mergeHooks(a.hooks, b.hooks),
    env: { ...(a.env ?? {}), ...(b.env ?? {}) },
    extras: { ...(a.extras ?? {}), ...(b.extras ?? {}) },
  }
}

function mergeArrays<T>(a?: T[], b?: T[]): T[] | undefined {
  if (!a && !b) return undefined
  return [...(a ?? []), ...(b ?? [])]
}

function mergeHooks(a?: HookConfig, b?: HookConfig): HookConfig | undefined {
  if (!a && !b) return undefined
  const result: HookConfig = {}
  const events: Array<keyof HookConfig> = [
    'SessionStart',
    'UserPromptSubmit',
    'PreToolUse',
    'PostToolUse',
    'Stop',
  ]
  for (const event of events) {
    const merged = [...(a?.[event] ?? []), ...(b?.[event] ?? [])]
    if (merged.length > 0) result[event] = merged
  }
  return Object.keys(result).length === 0 ? undefined : result
}

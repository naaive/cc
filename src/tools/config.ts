/**
 * Config tool — read or write whitelisted entries in `.forge/settings.json`.
 *
 * Lets the model adjust a curated set of settings (model preference, permission
 * mode, output style, web-fetch hosts, etc.). Mutating arbitrary keys would be
 * a footgun, so the tool only sees a host-supplied `supportedSettings`
 * registry: each entry has a path, a type, optional choice list, and a
 * description shown to the model.
 *
 * Caveat: changes only affect the **on-disk** settings.json. The agent was
 * constructed with one snapshot of settings; live behaviour won't change until
 * the host re-creates the agent. The tool surfaces this in its output so the
 * model doesn't get confused.
 */

import fs from 'node:fs'
import path from 'node:path'
import { tool } from 'langchain'
import { z } from 'zod'

export interface ConfigSettingSpec {
  /** Dot-notation path inside settings.json (e.g. "model", "permissionMode"). */
  key: string
  /** Where this setting lives. user → ~/.forge/settings.json, project → repo. */
  scope: 'user' | 'project' | 'local'
  type: 'string' | 'boolean' | 'number' | 'string[]'
  /** Enumerated choices when type=string. */
  choices?: readonly string[]
  description: string
}

export interface ConfigToolOptions {
  /** The whitelist of settings the model is allowed to read/write. */
  supportedSettings: readonly ConfigSettingSpec[]
  /** Working directory (used to find the project settings file). */
  cwd: string
  /** Override the user dir (default ~/.forge). */
  userDir?: string
}

/**
 * Default registry: a small safe set of settings hosts can extend.
 */
export const DEFAULT_SUPPORTED_SETTINGS: readonly ConfigSettingSpec[] = [
  {
    key: 'model',
    scope: 'project',
    type: 'string',
    description: 'Default model id (e.g. claude-sonnet-4-6).',
  },
  {
    key: 'permissionMode',
    scope: 'project',
    type: 'string',
    choices: ['default', 'acceptEdits', 'plan', 'bypassPermissions'],
    description: 'Initial permission mode for the next session.',
  },
  {
    key: 'outputStyle',
    scope: 'project',
    type: 'string',
    choices: ['concise', 'explanatory', 'learning'],
    description: 'Default output style preset.',
  },
  {
    key: 'allowedTools',
    scope: 'project',
    type: 'string[]',
    description: 'Allow-list of tool names (empty = all enabled).',
  },
  {
    key: 'deniedTools',
    scope: 'project',
    type: 'string[]',
    description: 'Deny-list of tool names.',
  },
  {
    key: 'webFetchAllowHosts',
    scope: 'project',
    type: 'string[]',
    description: 'Hostname suffixes WebFetch is allowed to fetch from.',
  },
]

const RELOAD_NOTE =
  '\n\n[note: this change is written to disk but does not affect the running agent until the host re-creates it]'

export function createConfigTool(options: ConfigToolOptions) {
  const byKey = new Map(options.supportedSettings.map(s => [s.key, s] as const))
  const keys = options.supportedSettings.map(s => s.key)
  const choicesText = options.supportedSettings
    .filter(s => s.choices)
    .map(s => `  - ${s.key}: ${s.choices!.map(c => `"${c}"`).join(', ')}`)
    .join('\n')

  const description = `Get or set a whitelisted configuration setting.

Usage:
- Read: pass only \`key\`. Returns the current value (across user/project/local merge).
- Write: pass \`key\` + \`value\`. Persists to the on-disk settings.json at the spec's scope.

Supported keys:
${options.supportedSettings.map(s => `  - ${s.key} (${s.scope}, ${s.type}): ${s.description}`).join('\n')}${
    choicesText ? `\n\nEnumerated values:\n${choicesText}` : ''
  }

Caveats:
- Writes are NOT hot-reloaded — the running agent keeps its old config until re-created.
- Booleans accept true/false; arrays accept a JSON array string ("[\\"a\\",\\"b\\"]") or a single string (treated as length-1 array).`

  const schema = z.object({
    key: z
      .enum(keys.length > 0 ? (keys as [string, ...string[]]) : ['model'])
      .describe('Setting key to read or write.'),
    value: z
      .string()
      .optional()
      .describe('Value to write. Omit to read the current value.'),
  })

  return tool(
    (input: z.infer<typeof schema>) => {
      const spec = byKey.get(input.key)
      if (!spec) return `unknown setting: ${input.key}`

      if (input.value === undefined) {
        const current = readMerged(input.key, options)
        return `${input.key} = ${JSON.stringify(current)}`
      }

      const parsed = parseValue(input.value, spec)
      if (parsed.error) return parsed.error
      try {
        writeAt(spec, input.key, parsed.value, options)
      } catch (err) {
        return `failed to write ${input.key}: ${(err as Error).message}`
      }
      return `set ${input.key} = ${JSON.stringify(parsed.value)} (scope: ${spec.scope})${RELOAD_NOTE}`
    },
    { name: 'Config', description, schema },
  )
}

function settingsPathFor(scope: 'user' | 'project' | 'local', options: ConfigToolOptions): string {
  if (scope === 'user') {
    const dir = options.userDir ?? path.join(process.env['HOME'] ?? '/tmp', '.forge')
    return path.join(dir, 'settings.json')
  }
  const root = path.resolve(options.cwd)
  return path.join(
    root,
    '.forge',
    scope === 'local' ? 'settings.local.json' : 'settings.json',
  )
}

function readMerged(key: string, options: ConfigToolOptions): unknown {
  // Merge across the three scopes the loader uses (user < project < local).
  for (const scope of ['local', 'project', 'user'] as const) {
    const p = settingsPathFor(scope, options)
    try {
      const raw = fs.readFileSync(p, 'utf8')
      const json = JSON.parse(raw) as Record<string, unknown>
      if (key in json) return json[key]
    } catch {
      // missing or malformed — fall through to next scope
    }
  }
  return undefined
}

function writeAt(
  spec: ConfigSettingSpec,
  key: string,
  value: unknown,
  options: ConfigToolOptions,
): void {
  const p = settingsPathFor(spec.scope, options)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  let json: Record<string, unknown> = {}
  try {
    json = JSON.parse(fs.readFileSync(p, 'utf8')) as Record<string, unknown>
  } catch {
    // file doesn't exist / is malformed — start fresh.
  }
  json[key] = value
  const tmp = `${p}.${process.pid}.tmp`
  fs.writeFileSync(tmp, `${JSON.stringify(json, null, 2)}\n`, 'utf8')
  fs.renameSync(tmp, p)
}

function parseValue(
  raw: string,
  spec: ConfigSettingSpec,
): { value?: unknown; error?: string } {
  switch (spec.type) {
    case 'string': {
      if (spec.choices && !spec.choices.includes(raw)) {
        return { error: `invalid choice "${raw}". Allowed: ${spec.choices.join(', ')}` }
      }
      return { value: raw }
    }
    case 'boolean': {
      if (raw === 'true') return { value: true }
      if (raw === 'false') return { value: false }
      return { error: `expected "true" or "false", got "${raw}"` }
    }
    case 'number': {
      const n = Number(raw)
      if (!Number.isFinite(n)) return { error: `not a number: "${raw}"` }
      return { value: n }
    }
    case 'string[]': {
      const trimmed = raw.trim()
      if (trimmed.startsWith('[')) {
        try {
          const arr = JSON.parse(trimmed) as unknown
          if (!Array.isArray(arr) || !arr.every(x => typeof x === 'string')) {
            return { error: `expected JSON array of strings: "${raw}"` }
          }
          return { value: arr }
        } catch {
          return { error: `malformed JSON array: "${raw}"` }
        }
      }
      // Bare string → length-1 array.
      return { value: [raw] }
    }
  }
}

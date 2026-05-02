/**
 * System-prompt assembly — the *only* place that decides what the model
 * actually sees.
 *
 * Layout (top to bottom):
 *   1. Identity prefix          — "You are Forge, …" (or embedded variant)
 *   2. Intro block              — interactive-agent posture, URL guard
 *   3. # System / # Doing tasks / # Tone / # Tool use / # Executing actions
 *   4. # Environment            — cwd / platform / git / model / today
 *   5. # Project memory         — concatenated AGENTS.md
 *   6. Appendix layers          — host appendix, deferred-tool listing,
 *                                 skills listing, output-style preset
 *
 * `assembleSystemPrompt` returns a single flattened string for callers
 * that just want the whole prompt. `buildCacheableSystemBlocks` returns
 * the same content split at the four cache breakpoints used by the
 * Anthropic prompt cache.
 */

import type { EnvironmentInfo } from '../env.js'
import { formatProjectMemory, type MemoryEntry } from '../memory.js'
import {
  ACTIONS_SECTION,
  AGENT_IDENTITY,
  buildEnvBlock,
  DOING_TASKS_SECTION,
  EMBEDDED_AGENT_IDENTITY,
  INTRO_BLOCK,
  SYSTEM_SECTION,
  TONE_SECTION,
  TOOL_USE_POLICY,
} from '../prompt.js'
import {
  formatOutputStyleSection,
  getOutputStyle,
  type OutputStyle,
} from '../outputStyles.js'
import type { SkillMetadata } from '../skills/index.js'
import type { DeferredToolRegistry } from '../tools/index.js'

export interface AssembleSystemPromptInput {
  env: EnvironmentInfo
  projectMemory?: MemoryEntry[]
  embedded?: boolean
  /** Replace the identity prefix entirely (advanced; sub-agents). */
  identityOverride?: string
  /** Free-form text appended after the core sections (host override). */
  systemPromptAppendix?: string
  deferredRegistry?: DeferredToolRegistry | null
  skills?: SkillMetadata[]
  outputStyle?: string | OutputStyle
  customOutputStyles?: Record<string, OutputStyle>
}

/**
 * One block of the system-prompt appendix. Sections render lazily so they
 * can decide to omit themselves (e.g. an empty skills list returns null).
 * A new appendix block — Plugins, Hints, Memos — adds a section here
 * without touching `composeAppendix`.
 */
export interface PromptSection {
  /** Stable identifier; useful in tests and tracing. */
  readonly name: string
  render(): string | null
}

export function assembleSystemPrompt(input: AssembleSystemPromptInput): string {
  const sections: string[] = [
    pickIdentity(input),
    INTRO_BLOCK,
    SYSTEM_SECTION,
    DOING_TASKS_SECTION,
    TONE_SECTION,
    TOOL_USE_POLICY,
    ACTIONS_SECTION,
    buildEnvBlock(input.env),
  ]
  if (input.projectMemory && input.projectMemory.length > 0) {
    sections.push(`# Project memory\n${formatProjectMemory(input.projectMemory)}`)
  }
  const appendix = composeAppendix(input)
  if (appendix) sections.push(appendix)
  return sections.join('\n\n')
}

/**
 * Split the system prompt into the four cache breakpoints used by Anthropic's
 * prompt cache.
 *
 * The Anthropic API allows at most 4 `cache_control` entries per request, with
 * the rule "everything before this marker is cached". We place markers at:
 *   1. End of identity + intro (very stable; effectively static).
 *   2. End of System / DoingTasks / Tone / ToolPolicy / Actions
 *      (changes only on harness upgrade).
 *   3. End of environment block + project memory + appendix (per-cwd; stable
 *      for the duration of a session).
 *   4. End of last user-message group — placed by the cache middleware, not
 *      here — the previous turn's conversation tail can still hit cache when
 *      the new turn arrives.
 *
 * The first three blocks are returned here; the fourth is a runtime concern.
 */
export function buildCacheableSystemBlocks(
  input: AssembleSystemPromptInput,
): { text: string; cacheable: boolean }[] {
  const identity = pickIdentity(input)
  const blocks: { text: string; cacheable: boolean }[] = []

  // Block 1: identity + intro. Static across all sessions for a given binary.
  blocks.push({ text: `${identity}\n\n${INTRO_BLOCK}`, cacheable: true })

  // Block 2: behavior policy. Stable across upgrades.
  blocks.push({
    text: [
      SYSTEM_SECTION,
      DOING_TASKS_SECTION,
      TONE_SECTION,
      TOOL_USE_POLICY,
      ACTIONS_SECTION,
    ].join('\n\n'),
    cacheable: true,
  })

  // Block 3: env + project memory + appendix. Stable per session.
  const tailParts: string[] = [buildEnvBlock(input.env)]
  if (input.projectMemory && input.projectMemory.length > 0) {
    tailParts.push(`# Project memory\n${formatProjectMemory(input.projectMemory)}`)
  }
  const appendix = composeAppendix(input)
  if (appendix) tailParts.push(appendix)
  blocks.push({ text: tailParts.join('\n\n'), cacheable: true })

  return blocks
}

export function resolveOutputStyle(
  styleArg: string | OutputStyle | undefined,
  custom: Record<string, OutputStyle> | undefined,
): OutputStyle | null {
  if (!styleArg) return null
  if (typeof styleArg === 'string') return getOutputStyle(styleArg, custom)
  return styleArg
}

export function formatSkillsListing(skills: SkillMetadata[]): string {
  const lines = skills.map(s => `  - ${s.name} [${s.source}]: ${s.description}`)
  return `# Skills

The following agent skills are installed. Each is a self-contained instruction module the user has chosen to make available. Call DiscoverSkills to filter, or Skill { name } to load one's full body.

${lines.join('\n')}`
}

function pickIdentity(input: AssembleSystemPromptInput): string {
  if (input.identityOverride) return input.identityOverride
  return input.embedded ? EMBEDDED_AGENT_IDENTITY : AGENT_IDENTITY
}

function composeAppendix(input: AssembleSystemPromptInput): string | null {
  const sections = appendixSections(input)
  const parts = sections
    .map(s => s.render())
    .filter((s): s is string => s !== null && s !== '')
  return parts.length > 0 ? parts.join('\n\n') : null
}

function appendixSections(input: AssembleSystemPromptInput): PromptSection[] {
  return [
    {
      name: 'host-appendix',
      render: () => input.systemPromptAppendix ?? null,
    },
    {
      name: 'deferred-tools',
      render: () => input.deferredRegistry?.toSystemPromptBlock() ?? null,
    },
    {
      name: 'skills',
      render: () =>
        input.skills && input.skills.length > 0
          ? formatSkillsListing(input.skills)
          : null,
    },
    {
      name: 'output-style',
      render: () => {
        const style = resolveOutputStyle(input.outputStyle, input.customOutputStyles)
        return style ? formatOutputStyleSection(style) : null
      },
    },
  ]
}

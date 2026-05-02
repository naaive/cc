/**
 * System-prompt assembly for the Claude Code agent.
 *
 * Composes the appendix that follows the cc-aligned base prompt:
 *   - user-supplied appendix
 *   - deferred-tool listing (when ToolSearch is enabled)
 *   - skill listing (when skills are loaded)
 *   - output style preset
 *
 * Kept separate from the base prompt sections (in `prompt.ts`) so the
 * static cc identity / behavior copy doesn't drown in dynamic-context
 * concerns.
 */

import type { ClaudeMdEntry } from '../claudemd.js'
import type { EnvironmentInfo } from '../env.js'
import { buildSystemPrompt } from '../prompt.js'
import {
  formatOutputStyleSection,
  getOutputStyle,
  type OutputStyle,
} from '../outputStyles.js'
import type { SkillMetadata } from '../skills/index.js'
import type { DeferredToolRegistry } from '../tools/index.js'

export interface AssembleSystemPromptInput {
  env: EnvironmentInfo
  claudeMd: ClaudeMdEntry[]
  agentSdk?: boolean
  systemPromptAppendix?: string
  deferredRegistry: DeferredToolRegistry | null
  skills: SkillMetadata[]
  outputStyle?: string | OutputStyle
  customOutputStyles?: Record<string, OutputStyle>
}

export function assembleSystemPrompt(input: AssembleSystemPromptInput): string {
  const parts: string[] = []
  if (input.systemPromptAppendix) parts.push(input.systemPromptAppendix)
  if (input.deferredRegistry) {
    const block = input.deferredRegistry.toSystemPromptBlock()
    if (block) parts.push(block)
  }
  if (input.skills.length > 0) parts.push(formatSkillsListing(input.skills))
  const style = resolveOutputStyle(input.outputStyle, input.customOutputStyles)
  if (style) parts.push(formatOutputStyleSection(style))

  return buildSystemPrompt({
    env: input.env,
    claudeMd: input.claudeMd,
    appendix: parts.length > 0 ? parts.join('\n\n') : undefined,
    agentSdk: input.agentSdk,
  })
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

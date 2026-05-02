/**
 * `DiscoverSkills` and `Skill` tools.
 *
 * `DiscoverSkills` returns a metadata listing — name + description for
 * each loaded skill. The model uses this to decide which skills are
 * relevant before pulling their bodies. we put a tiny one-line listing
 * in the system prompt and exposes DiscoverSkills as a deferred tool;
 * we follow the same model.
 *
 * `Skill` loads one skill's full body and returns it. The body becomes a
 * tool_result that the model can then follow as instructions for the
 * current task. Bodies are read on demand from disk every time — they're
 * small and the disk hit is negligible.
 */

import { tool } from 'langchain'
import { z } from 'zod/v4'
import {
  readSkillBody,
  type SkillMetadata,
} from './loader.js'

export interface SkillToolsOptions {
  /** Live skill registry. The factory reads this each call so SkillTool sees runtime additions. */
  getSkills: () => SkillMetadata[]
}

export const DISCOVER_SKILLS_TOOL_NAME = 'DiscoverSkills'
export const SKILL_TOOL_NAME = 'Skill'

const discoverSchema = z.object({
  query: z
    .string()
    .optional()
    .describe('Optional substring filter on skill name or description.'),
})

const DISCOVER_DESC = `List installed agent skills (name + description). Each skill is a self-contained instruction module the user has chosen to make available. Call \`Skill\` with a skill name to load its body.

Use this when:
 - The user mentions a domain (security review, migration, deployment, ...) where a skill might apply.
 - You're about to undertake a multi-step procedure that someone may have written down already.

DiscoverSkills is cheap; calling it before a non-trivial task is almost always the right move.`

const skillSchema = z.object({
  name: z
    .string()
    .min(1)
    .describe('Skill name as returned by DiscoverSkills.'),
})

const SKILL_DESC = `Load a skill's full body (instructions, examples, scripts to run). The body becomes a tool_result you should treat as authoritative guidance for the current task.

The skill body may itself reference other tools (Read/Edit/Bash/...) or instruct you to run a sub-agent (Agent). Follow it.`

export function createDiscoverSkillsTool(options: SkillToolsOptions) {
  return tool(
    (input: z.infer<typeof discoverSchema>) => {
      const skills = options.getSkills()
      if (skills.length === 0) return '(no skills installed)'
      const q = input.query?.toLowerCase().trim()
      const filtered = q
        ? skills.filter(
            s =>
              s.name.toLowerCase().includes(q) ||
              s.description.toLowerCase().includes(q),
          )
        : skills
      if (filtered.length === 0) return `(no skills match "${q ?? ''}")`
      return filtered
        .map(
          s =>
            `${s.name} [${s.source}]\n  ${s.description}${s.allowedTools ? `\n  pre-approved tools: ${s.allowedTools}` : ''}`,
        )
        .join('\n\n')
    },
    {
      name: DISCOVER_SKILLS_TOOL_NAME,
      description: DISCOVER_DESC,
      schema: discoverSchema,
    },
  )
}

export function createSkillTool(options: SkillToolsOptions) {
  return tool(
    (input: z.infer<typeof skillSchema>) => {
      const skill = options.getSkills().find(s => s.name === input.name)
      if (!skill) return `unknown skill: ${input.name}`
      try {
        const body = readSkillBody(skill.path)
        return `# Skill: ${skill.name}\n${skill.description}\n\n${body}`
      } catch (err) {
        return `failed to read skill ${input.name}: ${(err as Error).message}`
      }
    },
    {
      name: SKILL_TOOL_NAME,
      description: SKILL_DESC,
      schema: skillSchema,
    },
  )
}

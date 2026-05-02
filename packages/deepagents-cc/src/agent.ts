/**
 * createClaudeCodeAgent — the user-facing factory.
 *
 * Wires deepagents (planning + filesystem + subagents + summarization) with
 * the cc-only pieces (Bash, WebFetch, WebSearch, plan-mode tools,
 * AskUserQuestion, hooks, system reminders, permission-mode gating). The
 * result is a langchain `createAgent`-compatible graph — fully streamable,
 * checkpointer-friendly, and Studio-friendly.
 *
 * Design choices:
 *  - `createDeepAgent` is the foundation. We let it own filesystem and
 *    subagents instead of reimplementing them.
 *  - Permission middleware sits BEFORE deepagents' fs middleware so plan
 *    mode can deny writes without the fs layer ever seeing them.
 *  - cc tools are passed in `tools` rather than as middleware — they're
 *    independent. The plan-mode tools mutate state via Command updates.
 *  - System prompt = cc identity + env block + CLAUDE.md (if present) +
 *    user appendix. deepagents appends its own base prompt below ours.
 */

import { createDeepAgent, type SubAgent } from 'deepagents'
import type {
  StructuredTool,
  ClientTool,
  ServerTool,
} from '@langchain/core/tools'
import type { LanguageModelLike } from '@langchain/core/language_models/base'
import type { AgentMiddleware } from 'langchain'

import { collectEnvironment, type EnvironmentInfo } from './env.js'
import { loadClaudeMd } from './claudemd.js'
import { buildSystemPrompt } from './prompt.js'
import { loadSettings, type Settings } from './settings.js'
import { CC_TOOL_NAMES } from './tools/index.js'
import { createBashTool } from './tools/bash.js'
import { createWebFetchTool } from './tools/webFetch.js'
import { createWebSearchTool, type WebSearchImpl } from './tools/webSearch.js'
import {
  createEnterPlanModeTool,
  createExitPlanModeTool,
} from './tools/planMode.js'
import {
  createAskUserQuestionTool,
  type AskUserQuestionResponder,
} from './tools/askUserQuestion.js'
import { createPermissionModeMiddleware } from './middleware/permissionMode.js'
import {
  createSystemReminderMiddleware,
  stockReminders,
  type Reminder,
} from './middleware/systemReminder.js'
import {
  createHooksMiddleware,
  type HookConfig,
} from './middleware/hooks.js'
import type { PermissionMode } from './permissionMode.js'
import { ConfigurationError } from './errors.js'

export interface CreateClaudeCodeAgentParams {
  /** Model — string id or a LanguageModelLike instance. */
  model?: string | LanguageModelLike
  /** Custom user-supplied tools. Names must not collide with cc/deepagents builtins. */
  tools?: Array<StructuredTool | ClientTool | ServerTool>
  /** Subagents available via the `task` tool. */
  subagents?: SubAgent[]
  /** Override the cwd used for env/CLAUDE.md detection. */
  cwd?: string
  /** Override the auto-loaded settings. Useful for tests. */
  settings?: Settings
  /** Skip CLAUDE.md auto-load (still respects settings hooks etc). */
  skipClaudeMd?: boolean
  /** Initial permission mode. Overrides settings. */
  initialPermissionMode?: PermissionMode
  /** Plug in a real web search backend. */
  webSearch?: WebSearchImpl
  /** Override the AskUserQuestion responder (default: stdin readline). */
  askUserQuestion?: AskUserQuestionResponder
  /** Extra hooks merged on top of settings hooks. */
  hooks?: HookConfig
  /** Extra system reminders. */
  reminders?: Reminder[]
  /** Free-form prompt appendix appended to the cc system prompt. */
  systemPromptAppendix?: string
  /** Disable specific cc tools by name (e.g. ["bash"]). */
  disable?: ReadonlyArray<(typeof CC_TOOL_NAMES)[number]>
}

export interface ClaudeCodeAgentBundle {
  /** The compiled deepagents graph. */
  agent: ReturnType<typeof createDeepAgent>
  /** The fully resolved settings used to construct the agent. */
  settings: Settings
  /** The environment snapshot baked into the system prompt. */
  env: EnvironmentInfo
  /** Tool names actually wired into the agent (cc + user + deepagents). */
  toolNames: string[]
}

const ERROR = new Set([
  'TOOL_NAME_COLLISION',
  'INVALID_PERMISSION',
  'INVALID_AGENT_NAME',
] as const)
void ERROR

/**
 * Build a Claude Code agent on top of deepagents.
 */
export function createClaudeCodeAgent(
  params: CreateClaudeCodeAgentParams = {},
): ClaudeCodeAgentBundle {
  const cwd = params.cwd ?? process.cwd()
  const loaded = params.settings ? null : loadSettings({ cwd })
  const settings: Settings = params.settings ?? loaded?.merged ?? {}
  const modelId =
    (typeof params.model === 'string' ? params.model : undefined) ??
    settings.model ??
    'claude-sonnet-4-6'

  const env = collectEnvironment({ cwd, modelId })
  const claudeMd = params.skipClaudeMd ? [] : loadClaudeMd({ cwd })
  const systemPrompt = buildSystemPrompt({
    env,
    claudeMd,
    appendix: params.systemPromptAppendix,
  })

  // Build cc tools, honoring the disable list.
  const disabled = new Set(params.disable ?? [])
  const ccTools: Array<StructuredTool> = []
  if (!disabled.has('bash')) ccTools.push(createBashTool({ cwd }))
  if (!disabled.has('web_fetch'))
    ccTools.push(
      createWebFetchTool({ allowHosts: settings.webFetchAllowHosts }),
    )
  if (!disabled.has('web_search') && params.webSearch)
    ccTools.push(createWebSearchTool(params.webSearch))
  if (!disabled.has('enter_plan_mode')) ccTools.push(createEnterPlanModeTool())
  if (!disabled.has('exit_plan_mode')) ccTools.push(createExitPlanModeTool())
  if (!disabled.has('ask_user_question'))
    ccTools.push(createAskUserQuestionTool(params.askUserQuestion))

  // Collision check: cc tools vs user tools.
  const userTools = params.tools ?? []
  const userNames = new Set(userTools.map(t => t.name))
  const collisions = ccTools
    .map(t => t.name)
    .filter(n => userNames.has(n))
  if (collisions.length > 0) {
    throw new ConfigurationError(
      `User tools collide with cc built-ins: ${collisions.join(', ')}`,
      'TOOL_NAME_COLLISION',
    )
  }

  // Allow/deny tool filter from settings.
  const allowed = settings.allowedTools
    ? new Set(settings.allowedTools)
    : null
  const denied = new Set(settings.deniedTools ?? [])
  const filteredCc = ccTools.filter(t => {
    if (denied.has(t.name)) return false
    if (allowed && !allowed.has(t.name)) return false
    return true
  })

  // Middleware stack — order matters.
  const middleware: AgentMiddleware[] = []

  // Hooks first so SessionStart fires before anything else.
  if (settings.hooks || params.hooks) {
    middleware.push(
      createHooksMiddleware({
        hooks: mergeHookConfigs(settings.hooks, params.hooks),
        cwd,
      }),
    )
  }

  // Permission mode next — gates writes before deepagents' fs middleware.
  middleware.push(
    createPermissionModeMiddleware({
      initialMode:
        params.initialPermissionMode ?? settings.permissionMode ?? 'default',
      extraReadOnly: params.tools?.filter(t => isReadOnlyHint(t)).map(t => t.name),
    }),
  )

  // System reminders. Always include the plan-mode reminder; user reminders
  // append on top of stock ones.
  const allReminders: Reminder[] = [
    stockReminders.todoStale(),
    stockReminders.planModeActive(() => 'plan'), // placeholder; real read below
    ...(params.reminders ?? []),
  ]
  middleware.push(
    createSystemReminderMiddleware({ reminders: allReminders }),
  )

  // Hand off to deepagents.
  const agent = createDeepAgent({
    model: params.model ?? modelId,
    tools: [...filteredCc, ...userTools] as StructuredTool[],
    systemPrompt,
    subagents: params.subagents ?? [],
    middleware,
  })

  const toolNames = [
    ...filteredCc.map(t => t.name),
    ...userTools.map(t => t.name),
    // deepagents builtins
    'write_todos',
    'ls',
    'read_file',
    'write_file',
    'edit_file',
    'glob',
    'grep',
    'task',
  ]

  return { agent, settings, env, toolNames }
}

function mergeHookConfigs(
  a: HookConfig | undefined,
  b: HookConfig | undefined,
): HookConfig {
  if (!a) return b ?? {}
  if (!b) return a
  const out: HookConfig = {}
  const events: Array<keyof HookConfig> = [
    'SessionStart',
    'UserPromptSubmit',
    'PreToolUse',
    'PostToolUse',
    'Stop',
  ]
  for (const e of events) {
    const merged = [...(a[e] ?? []), ...(b[e] ?? [])]
    if (merged.length > 0) out[e] = merged
  }
  return out
}

function isReadOnlyHint(tool: { name: string; lc_kwargs?: { metadata?: Record<string, unknown> } }): boolean {
  const meta = tool.lc_kwargs?.metadata
  if (!meta) return false
  return meta['readOnly'] === true || meta['read_only'] === true
}

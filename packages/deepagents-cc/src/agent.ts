/**
 * createClaudeCodeAgent — wire the cc-aligned tool set, system prompt, and
 * middleware chain on top of `langchain.createAgent`.
 *
 * Tool names are now PascalCase to match cc:
 *   Bash / BashOutput / KillShell / Read / Write / Edit / NotebookEdit /
 *   Glob / Grep / TodoWrite / Agent / WebFetch / WebSearch /
 *   AskUserQuestion / ExitPlanMode.
 *
 * Middleware order (deliberate):
 *   1. Hooks                       — must fire first (SessionStart)
 *   2. PermissionMode              — gate writes before any tool runs
 *   3. ContextEngineering          — re-inject todo state, plan banner
 *   4. Summarization               — token-budget compaction
 *   5. PromptCache                 — attach cache_control markers last
 *   6. langchain anthropicPromptCachingMiddleware (when on Claude)
 */

import {
  anthropicPromptCachingMiddleware,
  createAgent,
  type AgentMiddleware,
} from 'langchain'
import type {
  ClientTool,
  ServerTool,
  StructuredTool,
} from '@langchain/core/tools'
import type { LanguageModelLike } from '@langchain/core/language_models/base'

import { collectEnvironment, type EnvironmentInfo } from './env.js'
import { loadClaudeMd } from './claudemd.js'
import { buildSystemPrompt } from './prompt.js'
import { loadSettings, type Settings } from './settings.js'
import {
  ALL_CC_TOOL_NAMES,
  BackgroundJobRegistry,
  createAgentTool,
  createAskUserQuestionTool,
  createBashTools,
  createEditTool,
  createExitPlanModeTool,
  createGlobTool,
  createGrepTool,
  createNotebookEditTool,
  createReadTool,
  createTodoWriteTool,
  createWebFetchTool,
  createWebSearchTool,
  createWriteTool,
  makeFileStateCache,
  PersistentShell,
  TOOL_NAMES,
  type AskUserQuestionResponder,
  type FileStateCache,
  type SubAgent,
  type ToolName,
  type WebSearchImpl,
} from './tools/index.js'
import {
  ccReminders,
  createContextEngineeringMiddleware,
  createHooksMiddleware,
  createPermissionModeMiddleware,
  createPromptCacheMiddleware,
  createSummarizationMiddleware,
  type HookConfig,
  type PromptCacheMiddlewareOptions,
  type Reminder,
  type SummarizationMiddlewareOptions,
} from './middleware/index.js'
import type { PermissionMode } from './permissionMode.js'
import { ConfigurationError } from './errors.js'

export interface CreateClaudeCodeAgentParams {
  model?: string | LanguageModelLike
  /** User-supplied tools. Names must not collide with cc built-ins. */
  tools?: Array<StructuredTool | ClientTool | ServerTool>
  /** Sub-agents available via the Agent tool. */
  subagents?: SubAgent[]
  cwd?: string
  settings?: Settings
  skipClaudeMd?: boolean
  initialPermissionMode?: PermissionMode
  webSearch?: WebSearchImpl
  askUserQuestion?: AskUserQuestionResponder
  hooks?: HookConfig
  /** Extra reminders appended after the default cc set. */
  reminders?: Reminder[]
  systemPromptAppendix?: string
  /** Use the Agent SDK identity prefix instead of the default cc one. */
  agentSdk?: boolean
  /** Disable specific cc tools by name. */
  disable?: ReadonlyArray<ToolName>
  fileStateCache?: FileStateCache
  shell?: PersistentShell
  jobRegistry?: BackgroundJobRegistry
  summarization?: SummarizationMiddlewareOptions | false
  promptCache?: PromptCacheMiddlewareOptions | false
}

export interface ClaudeCodeAgentBundle {
  agent: ReturnType<typeof createAgent>
  settings: Settings
  env: EnvironmentInfo
  /** Tool names actually wired into the agent. */
  toolNames: string[]
  shell: PersistentShell
  jobRegistry: BackgroundJobRegistry
}

export function createClaudeCodeAgent(
  params: CreateClaudeCodeAgentParams = {},
): ClaudeCodeAgentBundle {
  const cwd = params.cwd ?? process.cwd()
  const settings: Settings =
    params.settings ?? loadSettings({ cwd }).merged

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
    agentSdk: params.agentSdk,
  })

  const fileStateCache = params.fileStateCache ?? makeFileStateCache()
  const shell = params.shell ?? new PersistentShell({ cwd })
  const jobRegistry = params.jobRegistry ?? new BackgroundJobRegistry()

  const disabled = new Set<ToolName>(params.disable ?? [])
  const allowed = settings.allowedTools ? new Set(settings.allowedTools) : null
  const denied = new Set(settings.deniedTools ?? [])
  const isEnabled = (name: ToolName) =>
    !disabled.has(name) && !denied.has(name) && (!allowed || allowed.has(name))

  const ccTools: StructuredTool[] = []

  // Bash + bg jobs share state.
  if (isEnabled(TOOL_NAMES.Bash)) {
    const bundle = createBashTools({
      cwd,
      denyPatterns: settings.bashDeny,
      allowPatterns: settings.bashAllow,
      shellInstance: shell,
      jobRegistry,
    })
    ccTools.push(bundle.bash as StructuredTool)
    if (isEnabled(TOOL_NAMES.BashOutput)) ccTools.push(bundle.bashOutput as StructuredTool)
    if (isEnabled(TOOL_NAMES.KillShell)) ccTools.push(bundle.killShell as StructuredTool)
  }

  if (isEnabled(TOOL_NAMES.Read)) ccTools.push(createReadTool({ fileStateCache }))
  if (isEnabled(TOOL_NAMES.Write)) ccTools.push(createWriteTool({ fileStateCache }))
  if (isEnabled(TOOL_NAMES.Edit)) ccTools.push(createEditTool({ fileStateCache }))
  if (isEnabled(TOOL_NAMES.NotebookEdit)) ccTools.push(createNotebookEditTool())
  if (isEnabled(TOOL_NAMES.Glob)) ccTools.push(createGlobTool({ cwd }))
  if (isEnabled(TOOL_NAMES.Grep)) ccTools.push(createGrepTool({ cwd }))
  if (isEnabled(TOOL_NAMES.TodoWrite)) ccTools.push(createTodoWriteTool())

  if (isEnabled(TOOL_NAMES.WebFetch))
    ccTools.push(createWebFetchTool({ allowHosts: settings.webFetchAllowHosts }))
  if (isEnabled(TOOL_NAMES.WebSearch) && params.webSearch)
    ccTools.push(createWebSearchTool(params.webSearch))
  if (isEnabled(TOOL_NAMES.AskUserQuestion))
    ccTools.push(createAskUserQuestionTool(params.askUserQuestion))
  if (isEnabled(TOOL_NAMES.ExitPlanMode)) ccTools.push(createExitPlanModeTool())

  // Agent (sub-agent) tool — only wired when sub-agents are configured.
  if (
    params.subagents &&
    params.subagents.length > 0 &&
    isEnabled(TOOL_NAMES.Agent)
  ) {
    ccTools.push(
      createAgentTool({
        subagents: params.subagents,
        factory: sub => {
          const subBundle = createClaudeCodeAgent({
            ...params,
            cwd,
            subagents: [], // no recursion
            fileStateCache,
            shell,
            jobRegistry,
            model: sub.model ?? params.model,
            systemPromptAppendix: sub.systemPrompt,
            disable: sub.toolWhitelist
              ? (ALL_CC_TOOL_NAMES.filter(
                  n => !sub.toolWhitelist!.includes(n),
                ) as ToolName[])
              : params.disable,
          })
          return subBundle.agent as unknown as {
            invoke: (i: { messages: unknown[] }) => Promise<{ messages: Array<{ content: unknown }> }>
          }
        },
      }),
    )
  }

  // Collision check vs user tools.
  const userTools = params.tools ?? []
  const userNames = new Set(userTools.map(t => t.name))
  const collisions = ccTools.map(t => t.name).filter(n => userNames.has(n))
  if (collisions.length > 0) {
    throw new ConfigurationError(
      `User tools collide with cc built-ins: ${collisions.join(', ')}`,
      'TOOL_NAME_COLLISION',
    )
  }

  // Middleware chain — order matters (see header).
  const middleware: AgentMiddleware[] = []

  if (settings.hooks || params.hooks) {
    middleware.push(
      createHooksMiddleware({
        hooks: mergeHookConfigs(settings.hooks, params.hooks),
        cwd,
      }),
    )
  }

  middleware.push(
    createPermissionModeMiddleware({
      initialMode:
        params.initialPermissionMode ?? settings.permissionMode ?? 'default',
    }),
  )

  middleware.push(
    createContextEngineeringMiddleware({
      reminders: [
        ccReminders.todoState(),
        ccReminders.todoStaleNudge(),
        ccReminders.planModeActive(),
        ...(params.reminders ?? []),
      ],
    }),
  )

  if (params.summarization !== false) {
    middleware.push(createSummarizationMiddleware(params.summarization ?? {}))
  }

  if (params.promptCache !== false) {
    middleware.push(createPromptCacheMiddleware(params.promptCache ?? {}))
  }

  // langchain's built-in anthropic prompt-cache middleware handles the
  // conversation-side markers (last 1-2 user messages). We pair it with
  // ours which handles the system prompt + anchor.
  if (isAnthropicModel(params.model ?? modelId)) {
    middleware.push(
      anthropicPromptCachingMiddleware({
        unsupportedModelBehavior: 'ignore',
        minMessagesToCache: 1,
      }),
    )
  }

  const agent = createAgent({
    model: params.model ?? modelId,
    systemPrompt,
    tools: [...ccTools, ...userTools] as StructuredTool[],
    middleware,
  })

  return {
    agent,
    settings,
    env,
    toolNames: [...ccTools.map(t => t.name), ...userTools.map(t => t.name)],
    shell,
    jobRegistry,
  }
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

function isAnthropicModel(model: string | LanguageModelLike): boolean {
  if (typeof model === 'string') {
    if (model.includes(':')) return model.split(':')[0] === 'anthropic'
    return model.startsWith('claude')
  }
  // LanguageModelLike — best-effort name probe.
  const m = model as { getName?: () => string }
  if (typeof m.getName !== 'function') return false
  const name = m.getName()
  if (name === 'ChatAnthropic') return true
  if (name === 'ConfigurableModel') {
    const cfg = (model as { _defaultConfig?: { modelProvider?: string } })
      ._defaultConfig
    return cfg?.modelProvider === 'anthropic'
  }
  return false
}

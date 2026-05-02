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
  createMiddleware,
  humanInTheLoopMiddleware,
  type AgentMiddleware,
} from 'langchain'
import type {
  ClientTool,
  ServerTool,
  StructuredTool,
} from '@langchain/core/tools'
import type { LanguageModelLike } from '@langchain/core/language_models/base'
import type {
  BaseCheckpointSaver,
  BaseStore,
} from '@langchain/langgraph-checkpoint'

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
  createInMemoryResultStore,
  createNotebookEditTool,
  createReadTool,
  createToolSearchTool,
  createTodoWriteTool,
  createWebFetchTool,
  createWebSearchTool,
  createWriteTool,
  DeferredToolRegistry,
  makeFileStateCache,
  PersistentShell,
  TOOL_NAMES,
  type AskUserQuestionResponder,
  type FileStateCache,
  type ResultStore,
  type SubAgent,
  type ToolName,
  type WebSearchImpl,
} from './tools/index.js'
import {
  createDiscoverSkillsTool,
  createSkillActivator,
  createSkillTool,
  listSkills,
  type SkillActivator,
  type SkillMetadata,
} from './skills/index.js'
import { createSlashCommandTool } from './tools/slashCommandTool.js'
import { getOutputStyle, formatOutputStyleSection, type OutputStyle } from './outputStyles.js'
import type { PermissionRule } from './permissionRules.js'
import type { MultiServerMCPClient } from './mcp/index.js'
import {
  ccReminders,
  createContextEngineeringMiddleware,
  createDenialTrackingMiddleware,
  createHooksMiddleware,
  createPermissionModeMiddleware,
  createPromptCacheMiddleware,
  createResultEvictionMiddleware,
  createSummarizationMiddleware,
  roughTokenCount,
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
  /** Tool result eviction store (defaults to in-memory). Pass false to disable. */
  resultStore?: ResultStore | false
  /** Bytes threshold above which a tool result is evicted to the store. */
  evictResultsAboveBytes?: number
  /** Enable tool denial tracking middleware (default true). */
  trackDenials?: boolean
  /**
   * User skill directories. When set, DiscoverSkills + Skill tools are
   * registered automatically and skills are listed in the system prompt.
   */
  skills?: {
    userSkillsDir?: string | null
    projectSkillsDir?: string | null
    /** Inline skills (already-parsed metadata, e.g. for tests). */
    inline?: SkillMetadata[]
  }
  /**
   * Tools to register as **deferred** — only their NAMES land in the system
   * prompt; the model loads their schemas via ToolSearch on demand. Pass
   * the same `StructuredTool` instances you'd otherwise pass via `tools`.
   */
  deferredTools?: StructuredTool[]
  /** Auto-compact pre-warning thresholds (rough tokens). */
  autoCompactWarning?: {
    warnAt?: number
    triggerAt?: number
  } | false
  /** Fine-grained permission rules. Combined with `settings.permissions`. */
  permissionRules?: PermissionRule[]
  /** Allow fs tools to operate on directories beyond cwd. */
  additionalDirectories?: string[]
  /** Output style preset name, or a custom OutputStyle object. */
  outputStyle?: string | OutputStyle
  /** Custom output styles registered alongside the built-ins. */
  outputStyles?: Record<string, OutputStyle>
  /** Add the SlashCommand tool so the model can invoke /init, /compact, ... */
  exposeSlashCommandTool?: boolean
  /**
   * Optional MCP client (from `setupMcpServers()`). We keep MCP setup
   * separate so the synchronous factory stays synchronous.
   *
   * MCP tools should be passed via `deferredTools` so the model loads
   * their schemas on demand via `ToolSearch`.
   */
  mcpClient?: MultiServerMCPClient
  /**
   * Tool calls that should pause for human approval before running.
   * Wired through to langchain's `humanInTheLoopMiddleware`.
   */
  interruptOn?: Parameters<typeof humanInTheLoopMiddleware>[0]['interruptOn']
  /**
   * Persistence: passes straight through to `createAgent`. With a
   * checkpointer the agent can resume mid-conversation; with a store
   * it can read/write long-lived memory.
   */
  checkpointer?: BaseCheckpointSaver
  store?: BaseStore
}

export interface ClaudeCodeAgentBundle {
  agent: ReturnType<typeof createAgent>
  settings: Settings
  env: EnvironmentInfo
  /** Tool names actually wired into the agent (active surface). */
  toolNames: string[]
  /** Names of tools the model must fetch via ToolSearch before calling. */
  deferredToolNames: string[]
  /** Loaded skills (empty if none configured). */
  skills: SkillMetadata[]
  shell: PersistentShell
  jobRegistry: BackgroundJobRegistry
  resultStore: ResultStore | null
  deferredRegistry: DeferredToolRegistry | null
  /** MCP client passed in by the host (if any) — owner must call `.close()`. */
  mcpClient: MultiServerMCPClient | null
  /** Conditional skill activator (null when no activatePaths-equipped skills). */
  skillActivator: SkillActivator | null
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

  const fileStateCache = params.fileStateCache ?? makeFileStateCache()
  const shell = params.shell ?? new PersistentShell({ cwd })
  const jobRegistry = params.jobRegistry ?? new BackgroundJobRegistry()
  const resultStore =
    params.resultStore === false ? null : (params.resultStore ?? createInMemoryResultStore())

  // Load skills if any source is configured.
  const skills: SkillMetadata[] =
    params.skills
      ? [
          ...(params.skills.inline ?? []),
          ...listSkills({
            userSkillsDir: params.skills.userSkillsDir,
            projectSkillsDir: params.skills.projectSkillsDir,
          }),
        ]
      : []

  // Build a per-session deferred tool registry. Hosts seed it via
  // `deferredTools`; we always register the Skill body loader as deferred
  // so it doesn't pollute the main tool list.
  const deferredRegistry =
    params.deferredTools && params.deferredTools.length > 0
      ? new DeferredToolRegistry()
      : null
  if (deferredRegistry && params.deferredTools) {
    deferredRegistry.registerAll(params.deferredTools)
  }

  // Build the system prompt — appendix carries the deferred-tool block,
  // the skill listing, and the output-style preset.
  const promptAppendixParts: string[] = []
  if (params.systemPromptAppendix) promptAppendixParts.push(params.systemPromptAppendix)
  if (deferredRegistry) {
    const block = deferredRegistry.toSystemPromptBlock()
    if (block) promptAppendixParts.push(block)
  }
  if (skills.length > 0) {
    promptAppendixParts.push(buildSkillsListing(skills))
  }
  const style = resolveOutputStyle(
    params.outputStyle ?? settings.outputStyle,
    params.outputStyles,
  )
  if (style) promptAppendixParts.push(formatOutputStyleSection(style))

  const systemPrompt = buildSystemPrompt({
    env,
    claudeMd,
    appendix: promptAppendixParts.length > 0 ? promptAppendixParts.join('\n\n') : undefined,
    agentSdk: params.agentSdk,
  })

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

  // Skill activator — only created when skills declare activate-paths.
  const skillActivator =
    skills.some(s => s.activatePaths && s.activatePaths.length > 0)
      ? createSkillActivator(skills)
      : null

  // Merge additionalDirectories from settings + params.
  const additionalDirectories = [
    ...(settings.additionalDirectories ?? []),
    ...(params.additionalDirectories ?? []),
  ]

  if (isEnabled(TOOL_NAMES.Read))
    ccTools.push(
      createReadTool({
        fileStateCache,
        resultStore: resultStore ?? undefined,
        cwd,
        additionalDirectories,
        onFileRead: skillActivator ? abs => skillActivator.notice(abs) : undefined,
      }),
    )
  if (isEnabled(TOOL_NAMES.Write))
    ccTools.push(
      createWriteTool({ fileStateCache, cwd, additionalDirectories }),
    )
  if (isEnabled(TOOL_NAMES.Edit))
    ccTools.push(
      createEditTool({ fileStateCache, cwd, additionalDirectories }),
    )
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

  // ToolSearch — only when there are deferred tools to search for.
  if (deferredRegistry && deferredRegistry.size() > 0) {
    ccTools.push(createToolSearchTool(deferredRegistry) as StructuredTool)
  }

  // DiscoverSkills + Skill — only when skills are present.
  if (skills.length > 0) {
    ccTools.push(
      createDiscoverSkillsTool({ getSkills: () => skills }) as StructuredTool,
    )
    ccTools.push(
      createSkillTool({ getSkills: () => skills }) as StructuredTool,
    )
  }

  // SlashCommand tool — opt-in. cc exposes it; we leave it off unless the
  // host explicitly wants the model to be able to fire commands itself.
  if (params.exposeSlashCommandTool) {
    ccTools.push(createSlashCommandTool({ cwd }) as StructuredTool)
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
      rules: [
        ...(settings.permissions ?? []),
        ...(params.permissionRules ?? []),
      ],
    }),
  )

  // Denial tracking — must wrap tool calls before downstream middleware so
  // it can short-circuit identical retries.
  if (params.trackDenials !== false) {
    middleware.push(createDenialTrackingMiddleware())
  }

  // Result eviction — wraps tool calls AFTER they run, swapping huge
  // outputs for storage-id stubs (model fetches them back via Read).
  if (resultStore) {
    middleware.push(
      createResultEvictionMiddleware({
        store: resultStore,
        evictBytes: params.evictResultsAboveBytes,
      }),
    )
  }

  // Build the reminder set: cc defaults + autocompact warning + custom.
  const reminders = [
    ccReminders.todoState(),
    ccReminders.todoStaleNudge(),
    ccReminders.planModeActive(),
  ]
  if (params.autoCompactWarning !== false) {
    const warnAt = params.autoCompactWarning?.warnAt ?? 60_000
    const triggerAt =
      params.autoCompactWarning?.triggerAt ??
      (params.summarization !== false
        ? params.summarization?.triggerTokens ?? 80_000
        : 80_000)
    // The reminder needs the live message list to estimate tokens.
    // We close over a getter that reads from the live state via the
    // ContextEngineeringMiddleware's `state` argument — see below.
    let liveTokens = 0
    reminders.push(
      ccReminders.autoCompactWarning(() => liveTokens, warnAt, triggerAt),
    )
    // Track liveTokens by piggy-backing on the prompt-cache middleware's
    // pre-model hook: any beforeModel handler runs after this snapshotter.
    middleware.push(
      createMiddleware({
        name: 'TokenSnapshotMiddleware',
        beforeModel: (state: { messages: Array<{ content: unknown }> }) => {
          // roughTokenCount works on BaseMessage[]; we pass it the raw
          // structural shape, which is enough for char-counting.
          liveTokens = roughTokenCount(state.messages as Parameters<typeof roughTokenCount>[0])
          return undefined
        },
      }),
    )
  }
  if (skillActivator) {
    const skillsByName = new Map(skills.map(s => [s.name, s] as const))
    reminders.push(
      ccReminders.conditionalSkillActivation(skillActivator, skillsByName),
    )
  }
  reminders.push(...(params.reminders ?? []))

  middleware.push(createContextEngineeringMiddleware({ reminders }))

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

  // Human-in-the-loop tool approval — pure langchain primitive, exposed
  // verbatim. Hosts that wire their own approval UI just supply the
  // matching `interruptOn` config.
  if (params.interruptOn) {
    middleware.push(humanInTheLoopMiddleware({ interruptOn: params.interruptOn }))
  }

  const agent = createAgent({
    model: params.model ?? modelId,
    systemPrompt,
    tools: [...ccTools, ...userTools] as StructuredTool[],
    middleware,
    checkpointer: params.checkpointer,
    store: params.store,
  })

  return {
    agent,
    settings,
    env,
    toolNames: [...ccTools.map(t => t.name), ...userTools.map(t => t.name)],
    deferredToolNames: deferredRegistry
      ? deferredRegistry.list().map(m => m.tool.name)
      : [],
    skills,
    shell,
    jobRegistry,
    resultStore,
    deferredRegistry,
    mcpClient: params.mcpClient ?? null,
    skillActivator,
  }
}

function resolveOutputStyle(
  styleArg: string | OutputStyle | undefined,
  custom: Record<string, OutputStyle> | undefined,
): OutputStyle | null {
  if (!styleArg) return null
  if (typeof styleArg === 'string') return getOutputStyle(styleArg, custom)
  return styleArg
}

function buildSkillsListing(skills: SkillMetadata[]): string {
  const lines = skills.map(s => `  - ${s.name} [${s.source}]: ${s.description}`)
  return `# Skills

The following agent skills are installed. Each is a self-contained instruction module the user has chosen to make available. Call DiscoverSkills to filter, or Skill { name } to load one's full body.

${lines.join('\n')}`
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

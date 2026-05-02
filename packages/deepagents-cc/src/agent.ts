/**
 * `createClaudeCodeAgent` — public entrypoint of the harness.
 *
 * This file owns:
 *   - the public types (params, bundle return)
 *   - the orchestration: resolve params → build tools → build middleware
 *     → call `langchain.createAgent` → return the bundle.
 *
 * All the heavy lifting (tool registration, middleware chain assembly,
 * system-prompt appendix composition) lives in `./agent/*.ts`.
 */

import { createAgent } from 'langchain'
import type { AgentMiddleware } from 'langchain'
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
import { loadSettings, type Settings } from './settings.js'
import {
  BackgroundJobRegistry,
  createInMemoryResultStore,
  DeferredToolRegistry,
  makeFileStateCache,
  PersistentShell,
  type AskUserQuestionResponder,
  type FileStateCache,
  type ResultStore,
  type SubAgent,
  type ToolName,
  type WebSearchImpl,
} from './tools/index.js'
import {
  createSkillActivator,
  listSkills,
  type SkillActivator,
  type SkillMetadata,
} from './skills/index.js'
import type { OutputStyle } from './outputStyles.js'
import type { PermissionMode } from './permissionMode.js'
import type { PermissionRule } from './permissionRules.js'
import type { MultiServerMCPClient } from './mcp/index.js'
import type {
  ErrorRetryGuardOptions,
  HookConfig,
  PromptCacheMiddlewareOptions,
  Reminder,
  SummarizationMiddlewareOptions,
} from './middleware/index.js'

import { assembleSystemPrompt } from './agent/systemPromptAssembly.js'
import {
  ALL_CC_TOOL_NAMES,
  buildTools,
} from './agent/buildTools.js'
import { buildMiddleware } from './agent/buildMiddleware.js'

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
   * Error-retry guard. Pass `false` to disable, or an options object to
   * tune (e.g. `haltAfterConsecutive`). Default: enabled with defaults.
   */
  errorRetryGuard?: ErrorRetryGuardOptions | false
  /** Auto-pin the first user message so it survives every compaction tier. */
  autoPinFirstUserMessage?: boolean
  /** Skills sources. */
  skills?: {
    userSkillsDir?: string | null
    projectSkillsDir?: string | null
    inline?: SkillMetadata[]
  }
  /** Tools registered as deferred — model loads schemas via ToolSearch. */
  deferredTools?: StructuredTool[]
  /** Auto-compact pre-warning thresholds (rough tokens). */
  autoCompactWarning?:
    | {
        warnAt?: number
        triggerAt?: number
      }
    | false
  /** Fine-grained permission rules. Combined with `settings.permissions`. */
  permissionRules?: PermissionRule[]
  /** Allow fs tools to operate on directories beyond cwd. */
  additionalDirectories?: string[]
  /** Output style preset name, or a custom OutputStyle object. */
  outputStyle?: string | OutputStyle
  /** Custom output styles registered alongside the built-ins. */
  outputStyles?: Record<string, OutputStyle>
  /** MCP client (from `setupMcpServers`) — owner must call `.close()`. */
  mcpClient?: MultiServerMCPClient
  /** Persistence: passes through to `createAgent`. */
  checkpointer?: BaseCheckpointSaver
  store?: BaseStore
  /** Extra middleware appended at the end of the chain (host passthrough). */
  extraMiddleware?: AgentMiddleware[]
}

export interface ClaudeCodeAgentBundle {
  /** The compiled langchain agent (LangGraph). */
  agent: ReturnType<typeof createAgent>
  /** Resolved settings used to construct the agent. */
  settings: Settings
  /** Environment snapshot baked into the system prompt. */
  env: EnvironmentInfo
  /** Tool names actually wired into the agent (active surface). */
  toolNames: string[]
  /** Tools the model must fetch via ToolSearch before calling. */
  deferredToolNames: string[]
  /** Loaded skills (empty when none configured). */
  skills: SkillMetadata[]
  shell: PersistentShell
  jobRegistry: BackgroundJobRegistry
  resultStore: ResultStore | null
  deferredRegistry: DeferredToolRegistry | null
  mcpClient: MultiServerMCPClient | null
  skillActivator: SkillActivator | null
}

export function createClaudeCodeAgent(
  params: CreateClaudeCodeAgentParams = {},
): ClaudeCodeAgentBundle {
  const cwd = params.cwd ?? process.cwd()
  const settings = params.settings ?? loadSettings({ cwd }).merged
  const modelId =
    (typeof params.model === 'string' ? params.model : undefined) ??
    settings.model ??
    'claude-sonnet-4-6'

  const env = collectEnvironment({ cwd, modelId })
  const claudeMd = params.skipClaudeMd ? [] : loadClaudeMd({ cwd })

  // Per-session shared state.
  const fileStateCache = params.fileStateCache ?? makeFileStateCache()
  const shell = params.shell ?? new PersistentShell({ cwd })
  const jobRegistry = params.jobRegistry ?? new BackgroundJobRegistry()
  const resultStore =
    params.resultStore === false
      ? null
      : params.resultStore ?? createInMemoryResultStore()

  // Skills.
  const skills = params.skills
    ? [
        ...(params.skills.inline ?? []),
        ...listSkills({
          userSkillsDir: params.skills.userSkillsDir,
          projectSkillsDir: params.skills.projectSkillsDir,
        }),
      ]
    : []
  const skillActivator = skills.some(
    s => s.activatePaths && s.activatePaths.length > 0,
  )
    ? createSkillActivator(skills)
    : null

  // Deferred tool registry.
  const deferredRegistry =
    params.deferredTools && params.deferredTools.length > 0
      ? new DeferredToolRegistry()
      : null
  if (deferredRegistry && params.deferredTools) {
    deferredRegistry.registerAll(params.deferredTools)
  }

  // System prompt.
  const systemPrompt = assembleSystemPrompt({
    env,
    claudeMd,
    agentSdk: params.agentSdk,
    systemPromptAppendix: params.systemPromptAppendix,
    deferredRegistry,
    skills,
    outputStyle: params.outputStyle ?? settings.outputStyle,
    customOutputStyles: params.outputStyles,
  })

  // Tool list.
  const additionalDirectories = [
    ...(settings.additionalDirectories ?? []),
    ...(params.additionalDirectories ?? []),
  ]
  const userTools = (params.tools ?? []) as StructuredTool[]

  const { ccTools, allToolNames } = buildTools({
    cwd,
    settings,
    fileStateCache,
    shell,
    jobRegistry,
    resultStore,
    deferredRegistry,
    skillActivator,
    skills,
    subagents: params.subagents ?? [],
    subAgentFactory: sub => {
      // Sub-agent: share fileStateCache + shell + jobRegistry so disk state
      // stays coherent. Drop `subagents` to avoid runaway recursion.
      const subBundle = createClaudeCodeAgent({
        ...params,
        cwd,
        subagents: [],
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
        invoke: (i: { messages: unknown[] }) => Promise<{
          messages: Array<{ content: unknown }>
        }>
      }
    },
    webSearch: params.webSearch,
    askUserQuestion: params.askUserQuestion,
    additionalDirectories,
    disable: params.disable ?? [],
    userTools,
  })

  // Middleware chain.
  const middleware = buildMiddleware({
    cwd,
    model: params.model ?? modelId,
    settings,
    fileStateCache,
    shell,
    resultStore,
    skillActivator,
    skills,
    initialPermissionMode: params.initialPermissionMode,
    permissionRules: params.permissionRules,
    hooks: params.hooks,
    trackDenials: params.trackDenials,
    errorRetryGuard: params.errorRetryGuard,
    evictResultsAboveBytes: params.evictResultsAboveBytes,
    autoPinFirstUserMessage: params.autoPinFirstUserMessage,
    autoCompactWarning: params.autoCompactWarning,
    reminders: params.reminders,
    summarization: params.summarization,
    promptCache: params.promptCache,
    extraMiddleware: params.extraMiddleware,
  })

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
    toolNames: allToolNames,
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

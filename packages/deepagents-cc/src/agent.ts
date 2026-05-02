/**
 * createClaudeCodeAgent — assemble the full Claude Code agent on top of
 * `langchain.createAgent` directly (no deepagents wrapper).
 *
 * Why no deepagents:
 *  - Its filesystem tools live in agent state, not on real disk. cc edits
 *    real files; that's what makes the harness useful.
 *  - Its bash tool is a one-shot spawn — `cd` doesn't persist across
 *    calls. cc keeps a long-lived shell.
 *  - Its grep is regex-against-state-files; we want a ripgrep wrapper.
 *  - We need plan-mode, hooks, system reminders, settings, and CLAUDE.md
 *    injection regardless. That's most of the work; deepagents was only
 *    saving us a few hundred lines of glue.
 *
 * The result is a normal langchain `createAgent` graph: streaming,
 * checkpointers, Studio all work.
 */

import { createAgent, type AgentMiddleware } from 'langchain'
import type {
  StructuredTool,
  ClientTool,
  ServerTool,
} from '@langchain/core/tools'
import type { LanguageModelLike } from '@langchain/core/language_models/base'

import { collectEnvironment, type EnvironmentInfo } from './env.js'
import { loadClaudeMd } from './claudemd.js'
import { buildSystemPrompt } from './prompt.js'
import { loadSettings, type Settings } from './settings.js'
import {
  CC_TOOL_NAMES,
  createAskUserQuestionTool,
  createBashTool,
  createEditFileTool,
  createEnterPlanModeTool,
  createExitPlanModeTool,
  createGlobTool,
  createGrepTool,
  createLsTool,
  createReadFileTool,
  createTaskTool,
  createWebFetchTool,
  createWebSearchTool,
  createWriteFileTool,
  createWriteTodosTool,
  makeFileStateCache,
  PersistentShell,
  type AskUserQuestionResponder,
  type FileStateCache,
  type SubAgent,
  type WebSearchImpl,
} from './tools/index.js'
import {
  createHooksMiddleware,
  createPermissionModeMiddleware,
  createSummarizationMiddleware,
  createSystemReminderMiddleware,
  stockReminders,
  type HookConfig,
  type Reminder,
  type SummarizationMiddlewareOptions,
} from './middleware/index.js'
import type { PermissionMode } from './permissionMode.js'
import { ConfigurationError } from './errors.js'

export interface CreateClaudeCodeAgentParams {
  model?: string | LanguageModelLike
  /** User-supplied tools. Names must not collide with cc built-ins. */
  tools?: Array<StructuredTool | ClientTool | ServerTool>
  /** Sub-agents available via the `task` tool. */
  subagents?: SubAgent[]
  /** Override the cwd used for env detection / fs root / shell startup dir. */
  cwd?: string
  /** Override the auto-loaded settings (useful for tests). */
  settings?: Settings
  /** Skip CLAUDE.md auto-load. */
  skipClaudeMd?: boolean
  /** Initial permission mode. Overrides settings.permissionMode. */
  initialPermissionMode?: PermissionMode
  /** Plug in a real web search backend. Off by default. */
  webSearch?: WebSearchImpl
  /** Override the AskUserQuestion responder (default: stdin readline). */
  askUserQuestion?: AskUserQuestionResponder
  /** Hooks merged on top of settings.hooks. */
  hooks?: HookConfig
  /** Extra system reminders. */
  reminders?: Reminder[]
  /** Free-form system prompt appendix. */
  systemPromptAppendix?: string
  /** Disable specific cc tools by name. */
  disable?: ReadonlyArray<(typeof CC_TOOL_NAMES)[number]>
  /** Inject the FileStateCache (test seam; defaults to a fresh one). */
  fileStateCache?: FileStateCache
  /** Inject the persistent shell (test seam; defaults to a fresh one). */
  shell?: PersistentShell
  /** Override summarization defaults. Pass `false` to disable entirely. */
  summarization?: SummarizationMiddlewareOptions | false
}

export interface ClaudeCodeAgentBundle {
  /** The compiled langchain agent (LangGraph). */
  agent: ReturnType<typeof createAgent>
  /** Resolved settings used to construct the agent. */
  settings: Settings
  /** Environment snapshot baked into the system prompt. */
  env: EnvironmentInfo
  /** Tool names actually wired into the agent. */
  toolNames: string[]
  /** Underlying persistent shell (so the host can stop it on shutdown). */
  shell: PersistentShell
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
  })

  const fileStateCache = params.fileStateCache ?? makeFileStateCache()
  const shell = params.shell ?? new PersistentShell({ cwd })

  // Build the tool set, honoring the disable list and settings allow/deny.
  const disabled = new Set<string>(params.disable ?? [])
  const allowed = settings.allowedTools ? new Set(settings.allowedTools) : null
  const denied = new Set(settings.deniedTools ?? [])
  const isEnabled = (name: string) =>
    !disabled.has(name) && !denied.has(name) && (!allowed || allowed.has(name))

  const ccTools: StructuredTool[] = []

  if (isEnabled('bash'))
    ccTools.push(
      createBashTool({
        cwd,
        denyPatterns: settings.bashDeny,
        allowPatterns: settings.bashAllow,
        shellInstance: shell,
      }),
    )
  if (isEnabled('read_file')) ccTools.push(createReadFileTool({ fileStateCache }))
  if (isEnabled('write_file')) ccTools.push(createWriteFileTool({ fileStateCache }))
  if (isEnabled('edit_file')) ccTools.push(createEditFileTool({ fileStateCache }))
  if (isEnabled('ls')) ccTools.push(createLsTool({ rootBoundary: cwd }))
  if (isEnabled('glob')) ccTools.push(createGlobTool({ cwd }))
  if (isEnabled('grep')) ccTools.push(createGrepTool({ cwd }))
  if (isEnabled('write_todos')) ccTools.push(createWriteTodosTool())

  if (isEnabled('web_fetch'))
    ccTools.push(createWebFetchTool({ allowHosts: settings.webFetchAllowHosts }))
  if (isEnabled('web_search') && params.webSearch)
    ccTools.push(createWebSearchTool(params.webSearch))
  if (isEnabled('enter_plan_mode')) ccTools.push(createEnterPlanModeTool())
  if (isEnabled('exit_plan_mode')) ccTools.push(createExitPlanModeTool())
  if (isEnabled('ask_user_question'))
    ccTools.push(createAskUserQuestionTool(params.askUserQuestion))

  // task / subagents
  if (params.subagents && params.subagents.length > 0 && isEnabled('task')) {
    ccTools.push(
      createTaskTool({
        subagents: params.subagents,
        // Each task call gets a NEW agent — shared shell + cache so the
        // sub-agent doesn't lose disk state, but its own message list.
        factory: sub => {
          const subBundle = createClaudeCodeAgent({
            ...params,
            cwd,
            // No further sub-agents from a sub-agent (avoid runaway recursion).
            subagents: [],
            // Inherit shell + cache so file-edit guards stay coherent.
            fileStateCache,
            shell,
            // Sub-agent uses its own model if specified.
            model: sub.model ?? params.model,
            systemPromptAppendix: sub.systemPrompt,
            // Apply tool whitelist if any.
            disable: sub.toolWhitelist
              ? (CC_TOOL_NAMES.filter(
                  n => !sub.toolWhitelist!.includes(n),
                ) as (typeof CC_TOOL_NAMES)[number][])
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

  // Assemble middleware chain.
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
    createSystemReminderMiddleware({
      reminders: [
        stockReminders.todoStale(),
        stockReminders.planModeActive(() => 'plan'),
        ...(params.reminders ?? []),
      ],
    }),
  )

  if (params.summarization !== false) {
    middleware.push(
      createSummarizationMiddleware(
        params.summarization ?? {},
      ),
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

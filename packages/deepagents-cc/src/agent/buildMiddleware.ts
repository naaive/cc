/**
 * Assemble the middleware chain that wraps `createAgent`.
 *
 * Order matters and follows cc's pipeline:
 *
 *   1. Hooks                  fires SessionStart / UserPromptSubmit / etc.
 *   2. PermissionMode         gates writes (plan mode + per-rule allow/deny)
 *   3. DenialTracking         short-circuits identical re-tries of denied calls
 *   4. ErrorRetryGuard        same idea, but for failed tool calls
 *   5. ResultEviction         oversize tool results swap to a storage stub
 *   6. AutoPinFirstUserMsg    optional one-shot pinner
 *   7. TokenSnapshot          updates a closure for the autocompact reminder
 *   8. ContextEngineering     `<system-reminder>` injection (todos, plan, files…)
 *   9. Compaction             multi-tier T1-T5 compaction
 *  10. PromptCache            our system-tail cache markers
 *  11. anthropicPromptCachingMiddleware (when on Claude)
 *  12. extraMiddleware        host-supplied passthroughs (e.g. humanInTheLoop)
 */

import {
  createMiddleware,
  anthropicPromptCachingMiddleware,
  type AgentMiddleware,
} from 'langchain'
import type { LanguageModelLike } from '@langchain/core/language_models/base'
import {
  autoPinFirstByRole,
  ccReminders,
  createContextEngineeringMiddleware,
  createDenialTrackingMiddleware,
  createErrorRetryGuardMiddleware,
  createHooksMiddleware,
  createPermissionModeMiddleware,
  createPromptCacheMiddleware,
  createResultEvictionMiddleware,
  createSummarizationMiddleware,
  roughTokenCount,
  type ErrorRetryGuardOptions,
  type HookConfig,
  type PromptCacheMiddlewareOptions,
  type Reminder,
  type SummarizationMiddlewareOptions,
} from '../middleware/index.js'
import type { PermissionMode } from '../permissionMode.js'
import type { PermissionRule } from '../permissionRules.js'
import type { Settings } from '../settings.js'
import type { FileStateCache, PersistentShell, ResultStore } from '../tools/index.js'
import type { SkillActivator, SkillMetadata } from '../skills/index.js'

export interface BuildMiddlewareInput {
  cwd: string
  model: string | LanguageModelLike
  settings: Settings
  fileStateCache: FileStateCache
  shell: PersistentShell
  resultStore: ResultStore | null
  skillActivator: SkillActivator | null
  skills: SkillMetadata[]
  initialPermissionMode?: PermissionMode
  permissionRules?: PermissionRule[]
  hooks?: HookConfig
  trackDenials?: boolean
  errorRetryGuard?: false | ErrorRetryGuardOptions
  evictResultsAboveBytes?: number
  autoPinFirstUserMessage?: boolean
  autoCompactWarning?: false | { warnAt?: number; triggerAt?: number }
  reminders?: Reminder[]
  summarization?: false | SummarizationMiddlewareOptions
  promptCache?: false | PromptCacheMiddlewareOptions
  extraMiddleware?: AgentMiddleware[]
}

export function buildMiddleware(input: BuildMiddlewareInput): AgentMiddleware[] {
  const chain: AgentMiddleware[] = []

  if (input.settings.hooks || input.hooks) {
    chain.push(
      createHooksMiddleware({
        hooks: mergeHookConfigs(input.settings.hooks, input.hooks),
        cwd: input.cwd,
      }),
    )
  }

  chain.push(
    createPermissionModeMiddleware({
      initialMode:
        input.initialPermissionMode ?? input.settings.permissionMode ?? 'default',
      rules: [
        ...(input.settings.permissions ?? []),
        ...(input.permissionRules ?? []),
      ],
    }),
  )

  if (input.trackDenials !== false) {
    chain.push(createDenialTrackingMiddleware())
  }

  if (input.errorRetryGuard !== false) {
    chain.push(createErrorRetryGuardMiddleware(input.errorRetryGuard ?? {}))
  }

  if (input.resultStore) {
    chain.push(
      createResultEvictionMiddleware({
        store: input.resultStore,
        evictBytes: input.evictResultsAboveBytes,
      }),
    )
  }

  if (input.autoPinFirstUserMessage) {
    chain.push(
      createMiddleware({
        name: 'AutoPinFirstUserMessage',
        beforeAgent: (state: { messages: unknown[] }) => {
          autoPinFirstByRole(
            state.messages as Parameters<typeof autoPinFirstByRole>[0],
            'human',
          )
          return undefined
        },
      }),
    )
  }

  const reminders: Reminder[] = [
    ccReminders.todoState(),
    ccReminders.todoStaleNudge(),
    ccReminders.planModeActive(),
    ccReminders.fileStateContext(input.fileStateCache),
    ccReminders.cwdDrift(() => input.shell.lastCwd, input.cwd),
  ]

  if (input.autoCompactWarning !== false) {
    const warnAt = input.autoCompactWarning?.warnAt ?? 60_000
    const triggerAt =
      input.autoCompactWarning?.triggerAt ??
      (input.summarization === false
        ? 80_000
        : input.summarization?.triggerTokens ?? 80_000)
    let liveTokens = 0
    reminders.push(ccReminders.autoCompactWarning(() => liveTokens, warnAt, triggerAt))
    chain.push(
      createMiddleware({
        name: 'TokenSnapshotMiddleware',
        beforeModel: (state: { messages: Array<{ content: unknown }> }) => {
          liveTokens = roughTokenCount(
            state.messages as Parameters<typeof roughTokenCount>[0],
          )
          return undefined
        },
      }),
    )
  }

  if (input.skillActivator) {
    const skillsByName = new Map(input.skills.map(s => [s.name, s] as const))
    reminders.push(
      ccReminders.conditionalSkillActivation(input.skillActivator, skillsByName),
    )
  }

  if (input.reminders) reminders.push(...input.reminders)

  chain.push(createContextEngineeringMiddleware({ reminders }))

  if (input.summarization !== false) {
    chain.push(createSummarizationMiddleware(input.summarization ?? {}))
  }

  if (input.promptCache !== false) {
    chain.push(createPromptCacheMiddleware(input.promptCache ?? {}))
  }

  if (isAnthropicModel(input.model)) {
    chain.push(
      anthropicPromptCachingMiddleware({
        unsupportedModelBehavior: 'ignore',
        minMessagesToCache: 1,
      }),
    )
  }

  if (input.extraMiddleware) chain.push(...input.extraMiddleware)

  return chain
}

export function mergeHookConfigs(
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

export function isAnthropicModel(model: string | LanguageModelLike): boolean {
  if (typeof model === 'string') {
    if (model.includes(':')) return model.split(':')[0] === 'anthropic'
    return model.startsWith('claude')
  }
  const m = model as { getName?: () => string }
  if (typeof m.getName !== 'function') return false
  const name = m.getName()
  if (name === 'ChatAnthropic') return true
  if (name === 'ConfigurableModel') {
    const cfg = (model as { _defaultConfig?: { modelProvider?: string } })._defaultConfig
    return cfg?.modelProvider === 'anthropic'
  }
  return false
}

export {
  createPermissionModeMiddleware,
  type PermissionModeMiddlewareOptions,
} from './permissionMode.js'
export {
  createContextEngineeringMiddleware,
  ccReminders,
  type Reminder,
  type ReminderContext,
  type ContextEngineeringMiddlewareOptions,
  type CCReminderFactory,
} from './contextEngineering.js'
export {
  createHooksMiddleware,
  type Hook,
  type HookConfig,
  type HookEvent,
  type HookPayload,
  type HookResult,
  type HooksMiddlewareOptions,
  type InlineHook,
  type ShellHook,
} from './hooks.js'
export {
  createSummarizationMiddleware,
  pinMessage,
  type CompactionEvent,
  type SummarizationMiddlewareOptions,
} from './summarization.js'
export {
  createErrorRetryGuardMiddleware,
  type ErrorRetryGuardOptions,
} from './errorRetryGuard.js'
export {
  createPromptCacheMiddleware,
  type PromptCacheMiddlewareOptions,
} from './promptCache.js'
export {
  createResultEvictionMiddleware,
  type ResultEvictionMiddlewareOptions,
} from './resultEviction.js'
export {
  createDenialTrackingMiddleware,
  type DenialTrackingMiddlewareOptions,
} from './denialTracking.js'

// Internal helpers (autoPinFirstByRole, isMessagePinned, roughTokenCount,
// denialFingerprint, stableJson) live in `src/lib/` and are imported
// directly from there by callers that need them. Not re-exported from
// the public middleware barrel.

// Re-exported here so `agent/buildMiddleware.ts` can grab them in one shot.
export { autoPinFirstByRole, roughTokenCount } from '../lib/messageUtils.js'

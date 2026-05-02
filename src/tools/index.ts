/**
 * Tool registry — public exports.
 *
 * What's exported here is the host-facing surface: factories for every
 * tool plus the per-session state objects (PersistentShell,
 * BackgroundJobRegistry, ResultStore, DeferredToolRegistry, FileStateCache).
 *
 * Internal helpers — `htmlToText`, `globToRegex`, `levenshtein`,
 * `_resetRipgrepCache`, `FILE_UNCHANGED_STUB`, eviction stub builders —
 * stay inside the package. Users that need them can import directly from
 * `src/lib/` or the per-tool source.
 */

// tool registry — names, descriptions, and read/write classification.
export {
  ALL_TOOL_NAMES,
  READ_ONLY_TOOL_SET,
  WRITE_TOOL_SET,
  TOOL_DESCRIPTIONS,
  TOOL_NAMES,
  type ToolName,
} from './toolNames.js'

// Bash + bg jobs.
export {
  createBashTools,
  type BashToolBundle,
  type BashToolOptions,
} from './bash.js'
export {
  BackgroundJobRegistry,
  PersistentPowerShell,
  PersistentShell,
  type BackgroundJob,
  type HasLastCwd,
  type PersistentPowerShellOptions,
  type PersistentShellOptions,
  type PowerShellResult,
  type ShellResult,
} from './persistentShell.js'

// PowerShell tool factory (the underlying class lives in persistentShell.ts).
export {
  createPowerShellTool,
  type PowerShellToolOptions,
} from './powershell.js'

// Monitor (long-running bg process with completion notification).
export {
  createMonitorTool,
  MonitorRegistry,
  type MonitoredJob,
  type MonitorToolOptions,
} from './monitor.js'

// Cron (scheduled future invocations).
export {
  computeNextFire,
  createCronTools,
  createInMemoryCronStore,
  CronScheduler,
  type CronJob,
  type CronStore,
  type CronToolsBundle,
  type CronToolsOptions,
} from './cron.js'

// Config (whitelisted settings.json read/write).
export {
  createConfigTool,
  DEFAULT_SUPPORTED_SETTINGS,
  type ConfigSettingSpec,
  type ConfigToolOptions,
} from './config.js'

// SlashCommand (custom .forge/commands/ templates).
export {
  createDiscoverSlashCommandsTool,
  createSlashCommandTool,
  type SlashCommandToolOptions,
} from './slashCommand.js'

// Web.
export { createWebFetchTool, type WebFetchOptions } from './webFetch.js'
export {
  createWebSearchTool,
  type WebSearchHit,
  type WebSearchImpl,
} from './webSearch.js'

// Plan mode (only ExitPlanMode — we have no EnterPlanMode tool).
export { createExitPlanModeTool, PLAN_MODE_TOOL_NAMES } from './planMode.js'

// HITL.
export {
  createAskUserQuestionTool,
  type AskUserQuestionInput,
  type AskUserQuestionResponder,
  type QuestionOption,
} from './askUserQuestion.js'

// Filesystem (real disk, semantics).
export { createReadTool, type ReadToolOptions } from './read.js'
export { createWriteTool, type WriteToolOptions } from './write.js'
export { createEditTool, type EditToolOptions } from './edit.js'
export { createGlobTool, type GlobToolOptions } from './glob.js'
export { createGrepTool, type GrepToolOptions } from './grep.js'
export { createNotebookEditTool } from './notebookEdit.js'

// Planning + delegation.
export { createTodoWriteTool, type Todo } from './todoWrite.js'
export {
  createAgentTool,
  type AgentToolOptions,
  type SubAgent,
  type SubAgentFactory,
} from './agentTool.js'

// fs primitives + per-session caches.
export {
  DEFAULT_SKIP_DIRS,
  enforceBoundary,
  ensureAbsolute,
  makeFileStateCache,
  resolveRoots,
  type FileStateCache,
  type ResolvedRoots,
} from './fsUtils.js'
export {
  createFileStateGuard,
  FILE_UNCHANGED_STUB,
  type FileStateGuard,
  type FileStateGuardOptions,
} from './fileStateGuard.js'

// Context-engineering primitives (host-facing).
export {
  createToolSearchTool,
  DeferredToolRegistry,
  type DeferredToolMeta,
} from './toolSearch.js'
export {
  createInMemoryResultStore,
  DEFAULT_EVICT_BYTES,
  TOOLS_EXCLUDED_FROM_EVICTION,
  type EvictionPolicy,
  type ResultStore,
  type StoredResult,
} from './resultStore.js'
export {
  createTruncationPolicy,
  type TruncationDecision,
  type TruncationPolicy,
} from './truncationPolicy.js'
export { pathRecoveryHint } from './pathRecovery.js'

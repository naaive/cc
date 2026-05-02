// cc-aligned tool registry — names, descriptions, and read/write classification.
export {
  TOOL_NAMES,
  TOOL_DESCRIPTIONS,
  ALL_CC_TOOL_NAMES,
  CC_READ_ONLY_TOOLS,
  CC_WRITE_TOOLS,
  type ToolName,
} from './ccToolNames.js'

// Bash + bg jobs.
export {
  createBashTools,
  type BashToolOptions,
  type BashToolBundle,
} from './bash.js'
export {
  PersistentShell,
  BackgroundJobRegistry,
  type ShellResult,
  type PersistentShellOptions,
  type BackgroundJob,
} from './persistentShell.js'

// Web.
export {
  createWebFetchTool,
  type WebFetchOptions,
} from './webFetch.js'
export { htmlToText } from './htmlToText.js'
export {
  createWebSearchTool,
  type WebSearchHit,
  type WebSearchImpl,
} from './webSearch.js'

// Plan mode (only ExitPlanMode — cc has no EnterPlanMode tool).
export {
  createExitPlanModeTool,
  PLAN_MODE_TOOL_NAMES,
} from './planMode.js'

// HITL.
export {
  createAskUserQuestionTool,
  type AskUserQuestionInput,
  type AskUserQuestionResponder,
  type QuestionOption,
} from './askUserQuestion.js'

// Filesystem (real disk, cc-style semantics).
export { createReadTool, type ReadToolOptions } from './readFile.js'
export { createWriteTool, type WriteToolOptions } from './writeFile.js'
export { createEditTool, type EditToolOptions } from './editFile.js'
export { createGlobTool, type GlobToolOptions } from './glob.js'
export { globToRegex } from './globRegex.js'
export {
  createGrepTool,
  type GrepToolOptions,
  _resetRipgrepCache,
} from './grep.js'
export { createNotebookEditTool } from './notebookEdit.js'

// Planning + delegation.
export { createTodoWriteTool, type Todo } from './writeTodos.js'
export {
  createAgentTool,
  type SubAgent,
  type SubAgentFactory,
  type AgentToolOptions,
} from './task.js'

// Shared helpers.
export {
  addLineNumbers,
  applyDeterministicEdit,
  DEFAULT_SKIP_DIRS,
  enforceBoundary,
  ensureAbsolute,
  isBinaryFile,
  isWithinAllowedRoots,
  makeFileStateCache,
  readTextFile,
  resolveRoots,
  truncateLine,
  writeTextFile,
  type FileStateCache,
  type ResolvedRoots,
} from './fsUtils.js'

// Context-engineering primitives.
export {
  DeferredToolRegistry,
  createToolSearchTool,
  type DeferredToolMeta,
} from './toolSearch.js'
export {
  buildEvictionStub,
  createInMemoryResultStore,
  parseStorageUri,
  shouldEvict,
  storageUri,
  STORAGE_SCHEME,
  TOOLS_EXCLUDED_FROM_EVICTION,
  DEFAULT_EVICT_BYTES,
  type EvictionPolicy,
  type ResultStore,
  type StoredResult,
} from './resultStore.js'
export {
  createTruncationPolicy,
  type TruncationDecision,
  type TruncationPolicy,
} from './truncationPolicy.js'
export { FILE_UNCHANGED_STUB } from './readFile.js'
export {
  findSimilarFile,
  levenshtein,
  pathRecoveryHint,
  suggestPathUnderCwd,
} from './pathRecovery.js'
export {
  createSlashCommandTool,
  type SlashCommandToolOptions,
} from './slashCommandTool.js'

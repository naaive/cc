export { createBashTool, type BashToolOptions } from './bash.js'
export { PersistentShell, type ShellResult, type PersistentShellOptions } from './persistentShell.js'
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
export {
  createEnterPlanModeTool,
  createExitPlanModeTool,
  PLAN_MODE_TOOL_NAMES,
} from './planMode.js'
export {
  createAskUserQuestionTool,
  type AskUserQuestionInput,
  type AskUserQuestionResponder,
  type QuestionOption,
} from './askUserQuestion.js'

// Filesystem tools (real disk, cc-style semantics).
export { createReadFileTool, type ReadFileToolOptions } from './readFile.js'
export { createWriteFileTool, type WriteFileToolOptions } from './writeFile.js'
export { createEditFileTool, type EditFileToolOptions } from './editFile.js'
export { createLsTool, type LsToolOptions } from './ls.js'
export { createGlobTool, type GlobToolOptions, globToRegex } from './glob.js'
export { createGrepTool, type GrepToolOptions, _resetRipgrepCache } from './grep.js'

// Planning + delegation.
export { createWriteTodosTool, type Todo } from './writeTodos.js'
export {
  createTaskTool,
  type SubAgent,
  type SubAgentFactory,
  type TaskToolOptions,
} from './task.js'

// Shared helpers (exported for advanced users / tests).
export {
  addLineNumbers,
  applyDeterministicEdit,
  ensureAbsolute,
  isBinaryFile,
  makeFileStateCache,
  readTextFile,
  truncateLine,
  writeTextFile,
  type FileStateCache,
} from './fsUtils.js'

/**
 * Tool name registry for cc-only tools. Used to detect collisions with
 * user-supplied tools.
 */
export const CC_TOOL_NAMES = [
  // shell + web
  'bash',
  'web_fetch',
  'web_search',
  // plan mode
  'enter_plan_mode',
  'exit_plan_mode',
  // user interaction
  'ask_user_question',
  // filesystem
  'read_file',
  'write_file',
  'edit_file',
  'ls',
  'glob',
  'grep',
  // planning + delegation
  'write_todos',
  'task',
] as const

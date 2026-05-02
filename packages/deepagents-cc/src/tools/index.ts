export { createBashTool, type BashToolOptions } from './bash.js'
export {
  createWebFetchTool,
  htmlToText,
  type WebFetchOptions,
} from './webFetch.js'
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

/**
 * Tool name registry for cc-only tools. Used by createClaudeCodeAgent to
 * detect collisions with user-supplied tools.
 */
export const CC_TOOL_NAMES = [
  'bash',
  'web_fetch',
  'web_search',
  'enter_plan_mode',
  'exit_plan_mode',
  'ask_user_question',
] as const

/**
 * Forge — a coding-agent harness on top of `langchain.createAgent`.
 *
 * Public surface (this file). Anything not re-exported here is internal —
 * if you need it, import from the source path explicitly.
 */

// ── Agent factory + types ────────────────────────────────────────────
export {
  createForgeAgent,
  type ForgeAgentBundle,
  type CreateForgeAgentParams,
} from './agent.js'

// ── Errors ───────────────────────────────────────────────────────────
export { ConfigurationError, HookFailureError } from './errors.js'

// ── System prompt building blocks ────────────────────────────────────
export {
  ACTIONS_SECTION,
  buildEnvBlock,
  EMBEDDED_AGENT_IDENTITY,
  AGENT_IDENTITY,
  DOING_TASKS_SECTION,
  INTRO_BLOCK,
  SYSTEM_SECTION,
  TONE_SECTION,
  TOOL_USE_POLICY,
} from './prompt.js'
export {
  assembleSystemPrompt,
  buildCacheableSystemBlocks,
  formatSkillsListing,
  resolveOutputStyle,
  type AssembleSystemPromptInput,
} from './agent/systemPromptAssembly.js'

// ── Environment + memory ─────────────────────────────────────────────
export {
  captureGitStatus,
  collectEnvironment,
  type CollectEnvOptions,
  type EnvironmentInfo,
} from './env.js'
export {
  formatProjectMemory,
  loadProjectMemory,
  memoryFreshnessNote,
  type MemoryEntry,
  type LoadMemoryOptions,
} from './memory.js'

// ── Settings + permissions ───────────────────────────────────────────
export {
  loadSettings,
  mergeSettings,
  type LoadedSettings,
  type LoadSettingsOptions,
  type Settings,
} from './settings.js'
export {
  classifyTool,
  createPermissionContext,
  evaluatePermission,
  PERMISSION_MODES,
  READ_TOOL_NAMES,
  WRITE_TOOL_NAMES,
  type CreatePermissionContextOptions,
  type EvaluatePermissionInput,
  type PermissionContext,
  type PermissionDecision,
  type PermissionMode,
  type PermissionRule,
  type PermissionRuleMode,
} from './permission.js'

// ── Output styles ────────────────────────────────────────────────────
export {
  formatOutputStyleSection,
  getOutputStyle,
  OUTPUT_STYLES,
  type OutputStyle,
} from './outputStyles.js'

// ── Tools, middleware, skills, MCP — explicit barrels ───────────────
export * from './tools/index.js'
export * from './middleware/index.js'
export * from './skills/index.js'
export * from './commands/index.js'
export * from './mcp/index.js'

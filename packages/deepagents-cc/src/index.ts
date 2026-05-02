/**
 * @claude-code-best/deepagents-cc
 *
 * Claude Code, rebuilt on top of LangChain + deepagents.
 *
 * What this package adds on top of `deepagents`:
 *  - cc-style system prompt (identity, tone, tool-use policy, env block)
 *  - CLAUDE.md / AGENTS.md auto-discovery and injection
 *  - cc-only tools: bash, web_fetch, web_search, enter_plan_mode,
 *    exit_plan_mode, ask_user_question
 *  - Permission-mode middleware (default / plan / acceptEdits / bypassPermissions)
 *  - System-reminder middleware (cc's <system-reminder> injection mechanism)
 *  - Hooks middleware (SessionStart / UserPromptSubmit / PreToolUse /
 *    PostToolUse / Stop), supporting both inline JS and shell-command hooks
 *  - Settings loader that merges ~/.claude/settings.json,
 *    .claude/settings.json, .claude/settings.local.json
 *  - Slash command parser plus the standard `/clear /help /init /compact
 *    /memory /mode` set
 *
 * Usage:
 * ```ts
 * import { createClaudeCodeAgent } from "@claude-code-best/deepagents-cc";
 *
 * const { agent } = createClaudeCodeAgent();
 * const result = await agent.invoke({
 *   messages: [{ role: "user", content: "Refactor src/foo.ts" }]
 * });
 * ```
 */

export {
  createClaudeCodeAgent,
  type CreateClaudeCodeAgentParams,
  type ClaudeCodeAgentBundle,
} from './agent.js'

export { ConfigurationError, HookFailureError } from './errors.js'

export {
  buildSystemPrompt,
  buildEnvBlock,
  CORE_BEHAVIOR,
  CLAUDE_CODE_IDENTITY,
} from './prompt.js'

export {
  collectEnvironment,
  captureGitStatus,
  type EnvironmentInfo,
  type CollectEnvOptions,
} from './env.js'

export {
  loadClaudeMd,
  formatClaudeMd,
  type ClaudeMdEntry,
  type LoadClaudeMdOptions,
} from './claudemd.js'

export {
  loadSettings,
  mergeSettings,
  type Settings,
  type LoadSettingsOptions,
  type LoadedSettings,
} from './settings.js'

export {
  PERMISSION_MODES,
  classifyTool,
  decide as decidePermission,
  WRITE_TOOL_NAMES,
  READ_TOOL_NAMES,
  type PermissionMode,
  type PermissionDecision,
} from './permissionMode.js'

export * from './tools/index.js'
export * from './middleware/index.js'
export * from './slashCommands/index.js'

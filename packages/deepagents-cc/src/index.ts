/**
 * @claude-code-best/cc-on-langchain
 *
 * Claude Code, rebuilt directly on LangChain.
 *
 * No deepagents wrapper — its filesystem lives in agent state and its bash
 * tool is a one-shot spawn, neither of which fits cc's contract. We build
 * the full surface from scratch on top of `langchain.createAgent`:
 *
 *  - Real-disk filesystem tools with mtime-tracked stale-edit detection
 *    (read_file, write_file, edit_file with old_string/new_string semantics,
 *    ls, glob, grep with ripgrep autodetection).
 *  - Persistent-shell bash tool (`cd`, env, exports survive across calls).
 *  - Planning + delegation (write_todos, task with recursive sub-agents).
 *  - cc-style system prompt (identity, tone, tool policy, env block,
 *    CLAUDE.md / AGENTS.md auto-injection).
 *  - Plan / permission mode middleware (default / acceptEdits / plan /
 *    bypassPermissions) with read/write tool classification.
 *  - <system-reminder> middleware (stale-todo, plan-mode-active, …).
 *  - Hooks middleware (SessionStart / UserPromptSubmit / Pre+PostToolUse /
 *    Stop) with both inline JS and shell-command hooks.
 *  - Token-budget summarization middleware with pluggable summarizer.
 *  - .claude/settings.json hierarchy loader (user / project / local).
 *  - Slash command parser plus the standard set (/clear /help /init
 *    /compact /memory /mode).
 *  - `ccx` CLI (headless and interactive REPL).
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

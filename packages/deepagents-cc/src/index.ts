/**
 * @claude-code-best/cc-on-langchain
 *
 * A Claude-Code-grade harness built directly on `langchain.createAgent`.
 *
 * What's aligned with cc (as of v1.11.x):
 *  - Tool names (PascalCase): Bash / BashOutput / KillShell / Read /
 *    Write / Edit / NotebookEdit / Glob / Grep / TodoWrite / Agent /
 *    WebFetch / WebSearch / AskUserQuestion / ExitPlanMode.
 *  - Tool descriptions: copied verbatim from cc's `packages/builtin-tools/`
 *    where possible. Model behavior is sensitive to phrasing.
 *  - System prompt structure: identity prefix → intro → System →
 *    Doing tasks → Tone and style → Tool use policy → Executing actions
 *    with care → Environment → Project memory.
 *  - Three identity prefixes (cc / cc-in-Agent-SDK).
 *  - 4-breakpoint Anthropic prompt cache strategy (system tail + history
 *    anchor + langchain's built-in conversation markers + tools).
 *  - <system-reminder> injection on every turn for: todo state (full list,
 *    re-injected each turn), todo-stale nudge, plan-mode banner.
 *  - Permission modes: default / acceptEdits / plan / bypassPermissions,
 *    with cc's read/write tool classification.
 *  - Hooks: SessionStart / UserPromptSubmit / PreToolUse / PostToolUse /
 *    Stop, both inline JS and shell-command form.
 *  - Real-disk filesystem with `cat -n` line numbers, mtime-tracked stale-
 *    edit guard, deterministic single-occurrence Edit (replace_all opt-in).
 *  - Persistent shell + background-job registry powering BashOutput /
 *    KillShell, mirroring cc's `run_in_background` flow.
 *  - Token-budget summarization middleware (offline heuristic by default;
 *    pluggable LLM summarizer).
 *  - .claude/settings.json hierarchy loader.
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
  buildCacheableSystemBlocks,
  CLAUDE_CODE_IDENTITY,
  CLAUDE_CODE_AGENT_SDK_IDENTITY,
  INTRO_BLOCK,
  SYSTEM_SECTION,
  DOING_TASKS_SECTION,
  TONE_SECTION,
  TOOL_USE_POLICY,
  ACTIONS_SECTION,
  type BuildSystemPromptInput,
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
export * from './skills/index.js'

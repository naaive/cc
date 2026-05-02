# @claude-code-best/cc-on-langchain

**A Claude-Code-grade harness built directly on `langchain.createAgent`.**

Tool names, system prompt structure, prompt-cache strategy, system-reminder injection, permission modes, and tool semantics are all aligned with `claude-code` v1.11.x. No `deepagents` wrapper — its in-state filesystem and one-shot bash were too far from cc's contract to layer on top of.

## What's aligned with cc

| Layer                  | Detail                                                                                                                                                                                                          |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Tool names**         | PascalCase, identical to cc: `Bash`, `BashOutput`, `KillShell`, `Read`, `Write`, `Edit`, `NotebookEdit`, `Glob`, `Grep`, `TodoWrite`, `Agent`, `WebFetch`, `WebSearch`, `AskUserQuestion`, `ExitPlanMode`.       |
| **Tool descriptions**  | Copied verbatim from cc's `packages/builtin-tools/` where possible. Model behavior is sensitive to phrasing — paraphrasing changes when the model reaches for `Edit` vs. `Write`.                                |
| **System prompt**      | Same section order as cc: identity → intro (cyber-risk + URL rule) → `# System` → `# Doing tasks` → `# Tone and style` → `# Tool use policy` → `# Executing actions with care` → `# Environment` → project memory. |
| **Identity prefixes**  | Two cc prefixes: default and "Claude Agent SDK" preset (toggle via `agentSdk: true`).                                                                                                                            |
| **Prompt cache**       | 4-breakpoint Anthropic cache strategy. cc puts markers at: identity+intro, behavior policy, env+memory, and the message right before the rolling tail. langchain's built-in middleware adds the conversation-side markers. |
| **System reminders**   | `<system-reminder>` blocks injected on every turn for: full todo list (re-injected fresh every turn — that's how cc keeps todo state from scrolling off), todo-stale nudge, plan-mode active banner.             |
| **Permission modes**   | `default` / `acceptEdits` / `plan` / `bypassPermissions`. Plan mode blocks every cc-classified write tool plus every unknown tool.                                                                               |
| **Hooks**              | 5 events: `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop`. Inline JS or shell-command hooks.                                                                                             |
| **Settings**           | `~/.claude/settings.json` + `<repo>/.claude/settings.json` + `<repo>/.claude/settings.local.json`, merged in that order.                                                                                         |
| **Read/Edit/Write**    | Real disk. `Read` returns `cat -n` line-numbered output and tracks mtime. `Edit` requires a prior `Read` of the file (stale-edit guard) and rejects non-unique `old_string` unless `replace_all=true`. `Write` is atomic. |
| **Bash**               | Persistent shell — `cd`, exports, shell options carry across calls. `run_in_background: true` spawns a detached child whose stdout/stderr the model can poll with `BashOutput` and stop with `KillShell`.        |
| **Grep**               | Ripgrep when available, pure-Node fallback otherwise. cc's `output_mode` enum (`content`, `files_with_matches`, `count`) and `-i`, `multiline`, `glob`, `head_limit` all supported.                              |
| **Summarization**      | Token-budget compaction with a pluggable summarizer (offline heuristic by default).                                                                                                                              |
| **Slash commands**     | `/clear`, `/help`, `/init`, `/compact`, `/memory`, `/mode`.                                                                                                                                                      |
| **CLI**                | `ccx -p "..."` headless and `ccx` interactive REPL.                                                                                                                                                              |

## Quickstart

```ts
import { createClaudeCodeAgent } from "@claude-code-best/cc-on-langchain";

const { agent, shell, jobRegistry } = createClaudeCodeAgent({
  model: "claude-sonnet-4-6",
});

try {
  const result = await agent.invoke({
    messages: [{ role: "user", content: "Refactor src/foo.ts to use async/await" }],
  });
  console.log(result.messages.at(-1)?.content);
} finally {
  shell.stop();
  jobRegistry.stopAll();
}
```

The returned `agent` is a normal compiled LangGraph — streaming, checkpointers, and Studio all work as usual.

## Tool surface

```
Bash                Long-lived shell. cd / exports / shell options persist across calls.
                    run_in_background=true → spawn a detached job, return shell_id.
BashOutput          Read NEW output from a background job (cursor advances per poll).
KillShell           SIGTERM (then SIGKILL after 2s) a background job.

Read                file_path (absolute), optional offset/limit. Returns cat -n format.
Write               Atomic write. Existing files require a prior Read (stale-write guard).
Edit                Deterministic single-occurrence string replacement. replace_all opt-in.
NotebookEdit        Replace / insert / delete a Jupyter cell by id.

Glob                Pattern → paths, sorted by mtime newest-first.
Grep                Ripgrep-backed regex search; output_mode = files_with_matches | content | count.
WebFetch            HTTP(s) GET → markdown. Allow-host filter via settings.
WebSearch           BYO backend (pass `webSearch: async (q) => [...]`).

TodoWrite           Set the full todo list. Re-injected on every turn via system-reminder.
Agent               Dispatch a sub-agent with isolated context.
AskUserQuestion     ≤5 multi-choice questions; default backend reads stdin.
ExitPlanMode        Submit the agreed plan, return to default mode.
```

## Permission modes

| Mode                | Behaviour                                                                       |
| ------------------- | ------------------------------------------------------------------------------- |
| `default`           | Every tool runs.                                                                |
| `acceptEdits`       | Same as default for blocking; modes diverge in how the host UI prompts.         |
| `plan`              | Read-only. Every write tool returns "denied" until `ExitPlanMode`.              |
| `bypassPermissions` | Skip every check.                                                               |

## Prompt cache

cc places **4** `cache_control: ephemeral` markers per request. We do the same:

```
                                                       ←── cache hit boundary
[ identity + intro (very stable) ]                     ① cached
[ # System / # Doing tasks / # Tone / # Tool use … ]   ② cached
[ # Environment + project memory ]                     ③ cached
... older turns ...                                    ④ cached (anchor before rolling tail)
[ last user msg + last assistant msg ]                 ↑ rolling tail (not yet cached)
```

The first three markers are placed by `createPromptCacheMiddleware`; the fourth (and the conversation-side anchors) are placed by langchain's built-in `anthropicPromptCachingMiddleware`, which we wire in automatically when the model is Claude.

`extendedTtl: true` switches to the 1-hour beta TTL on supported models.

## Context engineering — system reminders

cc injects `<system-reminder>` blocks into the user's turn so the model sees just-in-time facts that don't deserve their own message. We ship the same set:

- **`todo-state`**: re-injects the FULL todo list every turn (cc's actual behavior). The model is expected to treat each turn's reminder as canonical.
- **`todo-stale-nudge`**: when no todo list exists and the conversation has gone N turns, suggest using `TodoWrite`.
- **`plan-mode-active`**: persistent banner reminding the model it's read-only until `ExitPlanMode`.
- **custom**: `ccReminders.custom("ci-mode", "You are running in CI; do NOT push to main.")` — fires every N turns.

```ts
import { createClaudeCodeAgent, ccReminders } from "@claude-code-best/cc-on-langchain";

createClaudeCodeAgent({
  reminders: [
    ccReminders.custom("style-rule", "Match the existing 2-space indent in this repo.", 5),
  ],
});
```

## Hooks

```ts
createClaudeCodeAgent({
  hooks: {
    PreToolUse: [
      payload => {
        if (
          payload.toolName === "Bash" &&
          /API_KEY=/.test(JSON.stringify(payload.toolInput))
        ) {
          return { block: true, message: "Refusing: looks like an API key was inlined." };
        }
      },
      { command: "node /opt/audit/preToolUse.js" },
    ],
  },
});
```

## Settings

```json
{
  "model": "claude-sonnet-4-6",
  "permissionMode": "default",
  "allowedTools": ["Read", "Grep", "Bash"],
  "bashDeny": ["rm -rf /", "git push --force"],
  "webFetchAllowHosts": ["docs.langchain.com"],
  "hooks": {
    "PreToolUse": [{ "command": "./scripts/audit-tool-call.sh" }]
  }
}
```

## CLI

```
$ ccx -p "list every TODO comment in src/"
$ echo "review this PR" | ccx -p
$ ccx
ccx — Claude Code on LangChain. Type /help for commands.
[default] > /mode plan
[plan] > sketch the refactor for the auth module
```

## Tests

```bash
$ bun test
 111 pass
 0 fail
```

The pure modules (cc tool registry, prompt assembly, fs helpers, glob regex, html→text, persistent shell contract, reminder factories, settings merge, claudemd loader, permission classification, NotebookEdit semantics) are 100% unit-tested.

## Why this lives in its own package

The `cc` repo is a fork of Claude Code itself, written against the Anthropic SDK directly with all the harness specifics (Ink REPL, MCP, ACP, daemon, …). This package is the *opposite* experiment: take the same tool surface and prompt structure but rebuild on `langchain.createAgent` to compare what it costs to drop into the LangGraph ecosystem (streaming / Studio / checkpointers / multi-provider model abstraction) without losing cc-grade tool semantics.

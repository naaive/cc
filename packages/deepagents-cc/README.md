# @claude-code-best/deepagents-cc

**Claude Code, rebuilt on top of LangChain + [deepagents](https://github.com/langchain-ai/deepagentsjs).**

`deepagents` ships a strong batteries-included agent (planning, filesystem, sub-agents, summarization). This package layers on the missing cc-style pieces: identity prompt, environment detection, `CLAUDE.md` injection, plan mode, permission gating, system reminders, hooks, settings, slash commands — and the tools deepagents intentionally left out (`bash`, `web_fetch`, `web_search`, `enter_plan_mode`, `exit_plan_mode`, `ask_user_question`).

## Quickstart

```ts
import { createClaudeCodeAgent } from "@claude-code-best/deepagents-cc";

const { agent } = createClaudeCodeAgent({
  model: "claude-sonnet-4-6",
});

const result = await agent.invoke({
  messages: [{ role: "user", content: "Refactor src/foo.ts to use async/await" }],
});

console.log(result.messages.at(-1)?.content);
```

The returned `agent` is a compiled LangGraph — streaming, checkpointers, and Studio all work as usual.

## What this package adds on top of `deepagents`

| Capability                       | Source                          |
| -------------------------------- | ------------------------------- |
| `bash` tool                      | `tools/bash.ts`                 |
| `web_fetch` tool (HTML→text)     | `tools/webFetch.ts`             |
| `web_search` tool (BYO backend)  | `tools/webSearch.ts`            |
| `enter_plan_mode` / `exit_plan_mode` | `tools/planMode.ts`         |
| `ask_user_question` tool         | `tools/askUserQuestion.ts`      |
| Permission-mode middleware       | `middleware/permissionMode.ts`  |
| `<system-reminder>` middleware   | `middleware/systemReminder.ts`  |
| Hooks middleware (5 events)      | `middleware/hooks.ts`           |
| `.claude/settings.json` loader   | `settings.ts`                   |
| CLAUDE.md / AGENTS.md auto-load  | `claudemd.ts`                   |
| cc-style identity + env prompt   | `prompt.ts`                     |
| Slash commands `/clear /help …`  | `slashCommands/`                |
| `ccx` CLI (headless + REPL)      | `cli.ts`                        |

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│  createClaudeCodeAgent({ ... })                              │
│  └─ buildSystemPrompt (identity + env + CLAUDE.md)           │
│                                                              │
│  middleware chain:                                           │
│    ├─ Hooks (SessionStart / UserPromptSubmit / Pre/Post)     │
│    ├─ PermissionMode (gate writes in plan mode)              │
│    ├─ SystemReminder (<system-reminder> injection)           │
│    └─ deepagents builtin: todos / fs / subagents / summary   │
│                                                              │
│  tools:                                                      │
│    ├─ deepagents: ls / read_file / write_file / edit_file /  │
│    │              glob / grep / write_todos / task           │
│    └─ cc additions: bash / web_fetch / web_search /          │
│                     enter_plan_mode / exit_plan_mode /       │
│                     ask_user_question / <user tools>         │
└──────────────────────────────────────────────────────────────┘
```

## Permission modes

Same four modes as cc:

- `default` — every tool runs (host UI may still prompt).
- `acceptEdits` — auto-approve writes; for use in trusted automation loops.
- `plan` — read-only; every write tool returns "denied" until `exit_plan_mode`.
- `bypassPermissions` — skip all checks. Off by default; opt in via env or settings.

```ts
import { createClaudeCodeAgent } from "@claude-code-best/deepagents-cc";

const { agent } = createClaudeCodeAgent({ initialPermissionMode: "plan" });
```

The model can also flip modes itself via `enter_plan_mode` / `exit_plan_mode`.

## Hooks

Both inline and shell-command hooks are supported:

```ts
createClaudeCodeAgent({
  hooks: {
    PreToolUse: [
      // Inline: redact secrets in bash invocations.
      payload => {
        if (
          payload.toolName === "bash" &&
          /API_KEY=/.test(JSON.stringify(payload.toolInput))
        ) {
          return { block: true, message: "Refusing: looks like an API key was inlined." };
        }
      },
      // Shell: external auditor.
      { command: "node /opt/audit/preToolUse.js" },
    ],
  },
});
```

## Settings file

`~/.claude/settings.json`, `<repo>/.claude/settings.json`, `<repo>/.claude/settings.local.json` are merged in that order.

```json
{
  "model": "claude-sonnet-4-6",
  "permissionMode": "default",
  "allowedTools": ["read_file", "grep", "bash"],
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

## Why rebuild cc on deepagents?

`deepagents` already nails the heavy lifting — planning, filesystem, sub-agents, summarization, model-agnostic prompt caching. cc has the polish layer: identity, environment, plan mode, hooks, settings, slash commands. Combining them gets a full Claude Code clone in well under 2k LoC, fully tested, and reuses the deepagents (LangGraph) ecosystem for streaming, checkpointing, and Studio.

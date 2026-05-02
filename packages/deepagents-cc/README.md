# @claude-code-best/cc-on-langchain

**Claude Code, rebuilt directly on LangChain** — without the `deepagents` wrapper.

We tried `deepagents` as a base in the first iteration and pulled it back out: its filesystem tools live in agent state instead of touching real disk, its `bash` is a one-shot `spawn` that loses `cd` between calls, and its `grep` is a regex-against-state-files toy. cc edits real files and runs real shells; that means rebuilding those tools from the ground up and assembling everything on `langchain.createAgent` directly.

## What's in the box

| Layer        | Files                                                                                                                                                                                              |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Filesystem   | `tools/readFile.ts`, `tools/writeFile.ts`, `tools/editFile.ts`, `tools/ls.ts`, `tools/glob.ts`, `tools/grep.ts`, `tools/fsUtils.ts` (real disk, mtime stale-edit guard, atomic writes)             |
| Shell        | `tools/persistentShell.ts`, `tools/bash.ts` (long-lived shell — `cd`, exports, shell options persist across tool calls; allow/deny patterns; output truncation; clean timeout teardown)            |
| Web          | `tools/webFetch.ts`, `tools/webSearch.ts`                                                                                                                                                          |
| Plan mode    | `tools/planMode.ts` (`enter_plan_mode`, `exit_plan_mode`)                                                                                                                                          |
| HITL         | `tools/askUserQuestion.ts`                                                                                                                                                                         |
| Planning     | `tools/writeTodos.ts`                                                                                                                                                                              |
| Delegation   | `tools/task.ts` (recursive sub-agent dispatch with isolated context)                                                                                                                               |
| Middleware   | `middleware/permissionMode.ts`, `middleware/systemReminder.ts`, `middleware/hooks.ts`, `middleware/summarization.ts`                                                                               |
| Prompt       | `prompt.ts` (cc-style identity + tone + tool policy + env block), `claudemd.ts` (CLAUDE.md / AGENTS.md auto-injection)                                                                             |
| Settings     | `settings.ts` (`~/.claude/settings.json` + project + local merge)                                                                                                                                  |
| Slash        | `slashCommands/` (/clear, /help, /init, /compact, /memory, /mode)                                                                                                                                  |
| CLI          | `cli.ts` (`ccx -p` headless and interactive REPL)                                                                                                                                                  |

## Why these specific contracts matter

- **edit_file requires `old_string` to occur exactly once.** Fuzzy matching feels nicer until you watch a model accidentally replace a comment that happens to match. Strict equality + uniqueness is what keeps multi-file refactors safe.
- **read_file emits `cat -n`-style line numbers.** `edit_file:` references and `file:line` jumps both depend on the model seeing line numbers consistently.
- **Mtime-tracked stale-edit guard.** If a file changed on disk since the model last read it, `edit_file` and `write_file` refuse and tell the model to re-read. Silent overwrites of human edits are the worst class of bug.
- **Persistent shell.** A shell where `cd foo && pwd` and a later `pwd` agree feels obvious to a human; for an agent it's the difference between coherent multi-step shell work and constant cwd drift.
- **Plan mode is a tool-class gate, not a model instruction.** The model can decide to enter plan mode; the middleware enforces it. Anything not on the read-only allowlist returns "denied" — including unknown user-defined tools, because plan-mode-by-default-deny is the correct posture.

## Quickstart

```ts
import { createClaudeCodeAgent } from "@claude-code-best/cc-on-langchain";

const { agent, shell } = createClaudeCodeAgent({
  model: "claude-sonnet-4-6",
  // optional: web search backend
  webSearch: async query => myProvider.search(query),
  // optional: starting permission mode
  initialPermissionMode: "default",
});

try {
  const result = await agent.invoke({
    messages: [{ role: "user", content: "Refactor src/foo.ts to use async/await" }],
  });
  console.log(result.messages.at(-1)?.content);
} finally {
  shell.stop(); // tear down the persistent bash on exit
}
```

The returned `agent` is a normal compiled LangGraph — streaming, checkpointers, and Studio all work as usual.

## Sub-agents

```ts
const { agent } = createClaudeCodeAgent({
  subagents: [
    {
      name: "search-helper",
      description: "Use for open-ended code search across the repo.",
      systemPrompt: "You search; you don't write. Return concise paths + line numbers.",
      toolWhitelist: ["read_file", "ls", "glob", "grep"],
    },
  ],
});
```

The `task` tool gets registered automatically when at least one sub-agent is configured. Each `task` call recursively spins up a fresh `createClaudeCodeAgent` with the sub-agent's whitelist, sharing the same `FileStateCache` and persistent shell so disk state stays coherent.

## Permission modes

| Mode                | Behaviour                                                                       |
| ------------------- | ------------------------------------------------------------------------------- |
| `default`           | Every tool runs. (Host UI may still prompt the user.)                           |
| `acceptEdits`       | Same as default for blocking; modes diverge in how the host UI prompts.         |
| `plan`              | Read-only. Every write tool returns "denied" until `exit_plan_mode`.            |
| `bypassPermissions` | Skip every check. Off by default; opt in via env or settings.                   |

```ts
createClaudeCodeAgent({ initialPermissionMode: "plan" });
```

The model can also flip modes itself via `enter_plan_mode` / `exit_plan_mode`.

## Hooks

Both inline JS and shell-command hooks are supported, on five events: `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop`.

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
      // Shell: external auditor. Receives a JSON payload on stdin.
      { command: "node /opt/audit/preToolUse.js" },
    ],
  },
});
```

## Summarization

Token-budget-driven compaction. By default we count rough tokens (chars/4); when the conversation crosses 80k, we fold the oldest run into a single `SystemMessage`. Provide your own `summarize` to use a real LLM:

```ts
createClaudeCodeAgent({
  summarization: {
    triggerTokens: 60_000,
    keepTail: 16,
    summarize: async messages => {
      const reply = await myLLM.invoke([
        new SystemMessage("Summarize this conversation in <300 words..."),
        ...messages,
      ]);
      return typeof reply.content === "string" ? reply.content : "";
    },
  },
});
```

## Settings

`~/.claude/settings.json`, `<repo>/.claude/settings.json`, and `<repo>/.claude/settings.local.json` are merged in that order.

```json
{
  "model": "claude-sonnet-4-6",
  "permissionMode": "default",
  "allowedTools": ["read_file", "grep", "bash"],
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
 78 pass
 0 fail
```

The tests cover the pure helpers (`fsUtils`, `globRegex`, `htmlToText`, prompt assembly, slash command parsing, settings merge, permission classification, claudemd discovery, env detection) plus the full persistent-shell contract (cwd persistence, exports persistence, stdout/stderr separation, output truncation, call serialization, timeout teardown).

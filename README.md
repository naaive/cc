# Forge

A coding-agent harness built directly on `langchain.createAgent`.

Forge gives you a complete, batteries-included coding agent: real-disk filesystem tools, a long-lived persistent shell, ripgrep-backed search, plan / accept-edits / bypass permission modes, hooks, system reminders, settings, slash commands, sub-agents, MCP, multi-tier compaction, and prompt caching — all wired into the LangGraph runtime so streaming, checkpointers, and Studio work out of the box.

## What you get from LangChain

| Layer                          | Source                                                                              |
| ------------------------------ | ----------------------------------------------------------------------------------- |
| Agent loop                     | `createAgent` from `langchain`                                                      |
| Middleware framework           | `createMiddleware`, `AgentMiddleware` from `langchain`                              |
| Tool factory                   | `tool()` + `StructuredTool` / `ClientTool` / `ServerTool` from `@langchain/core`    |
| Messages                       | `SystemMessage` / `HumanMessage` / `ToolMessage` / `BaseMessage` from `langchain`   |
| Models                         | `LanguageModelLike` from `@langchain/core/language_models/base`                     |
| State updates                  | `Command` from `@langchain/langgraph`                                               |
| Checkpointer / Store           | `BaseCheckpointSaver` / `BaseStore` from `@langchain/langgraph-checkpoint`          |
| Conversation prompt cache      | `anthropicPromptCachingMiddleware` from `langchain` (system-tail markers added on top) |
| Human-in-the-loop approval     | `humanInTheLoopMiddleware` from `langchain` (`interruptOn` param)                   |
| Summarization (opt-in)         | `summarizationMiddleware` from `langchain` (`preferLangchainSummarization: true`)   |
| MCP                            | `@langchain/mcp-adapters` (peer dep) via `setupMcpServers` thin wrapper             |

## What Forge adds on top

| Component                        | Why custom                                                                                  |
| -------------------------------- | -------------------------------------------------------------------------------------------- |
| Real-disk fs tools               | LangChain has no fs tools; Forge edits real files with mtime stale-edit guard               |
| `PersistentShell` + bg jobs      | `cd` / exports persist across calls; BashOutput / KillShell registry                        |
| `DeferredToolRegistry` + ToolSearch | On-demand schema loading                                                                  |
| `ResultStore` + eviction         | `forge-store://` swap-out for oversized tool results                                          |
| Permission modes + rules         | Plan / acceptEdits / bypass + per-tool / per-arg pattern rules                              |
| `<system-reminder>` engine       | Per-turn todo state / plan banner / skill activation injection                              |
| Skills loader                    | Anthropic Agent Skills spec (`SKILL.md` frontmatter)                                          |
| Prompt cache (system tail)       | Anthropic-API breakpoints on identity / behavior / env tiers                                 |
| Output styles                    | Built-in presets (`concise` / `explanatory` / `learning`) + custom registry                 |
| Path recovery                    | "Did you mean ...?" Levenshtein + cwd basename walk                                           |
| Truncation policy                | Per-tool refine-query / page-next / generic hints                                            |
| `TodoWrite` tool                 | `TodoWrite` (PascalCase) so the model sees the same name in prompt and registry             |
| Hooks (5 events)                 | Inline JS + shell-command hooks                                                              |

## Quickstart

```ts
import { createForgeAgent } from "@naaive/forge";

const { agent, shell, jobRegistry } = createForgeAgent({
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

PowerShell          Persistent PowerShell on Windows hosts.
Monitor             Long-running bg process with completion notification.
CronCreate / CronList / CronDelete   In-process scheduler (pluggable store).
Config              Read/write a host-supplied whitelist of settings.json keys.
SlashCommand / DiscoverSlashCommands  Custom command templates.
```

## Permission modes

| Mode                | Behaviour                                                                       |
| ------------------- | ------------------------------------------------------------------------------- |
| `default`           | Every tool runs.                                                                |
| `acceptEdits`       | Same as default for blocking; modes diverge in how the host UI prompts.         |
| `plan`              | Read-only. Every write tool returns "denied" until `ExitPlanMode`.              |
| `bypassPermissions` | Skip every check.                                                               |

## Prompt cache

Forge places **4** `cache_control: ephemeral` markers per request, lining up with the four-position cap that Anthropic's prompt cache supports:

```
                                                       ←── cache hit boundary
[ identity + intro (very stable) ]                     ① cached
[ # System / # Doing tasks / # Tone / # Tool use … ]   ② cached
[ # Environment + project memory ]                     ③ cached
... older turns ...                                    ④ cached (anchor before rolling tail)
[ last user msg + last assistant msg ]                 ↑ rolling tail (not yet cached)
```

The first three markers are placed by `createPromptCacheMiddleware`; the fourth (and the conversation-side anchors) are placed by langchain's built-in `anthropicPromptCachingMiddleware`, which is wired in automatically when the model is Claude.

`extendedTtl: true` switches to the 1-hour beta TTL on supported models.

## Context engineering — system reminders

Forge injects `<system-reminder>` blocks into the user's turn so the model sees just-in-time facts that don't deserve their own message:

- **`todo-state`**: re-injects the FULL todo list every turn. The model is expected to treat each turn's reminder as canonical.
- **`todo-stale-nudge`**: when no todo list exists and the conversation has gone N turns, suggest using `TodoWrite`.
- **`plan-mode-active`**: persistent banner reminding the model it's read-only until `ExitPlanMode`.
- **`file-state`**: every turn the FileStateCache changed, list "files you've already Read this session" (with mtimes, capped) so the model doesn't blindly re-Read.
- **`cwd-drift`**: when the persistent shell's live cwd diverges from the cwd baked into the env block (because the model ran `cd` somewhere), fire a one-time reminder with the new cwd + how to return.
- **`compaction-applied`**: after any compaction tier fires, list what was preserved and how many tokens were saved.
- **`auto-compact-warning`**: pre-warning when conversation crosses ~75% of the summarization trigger.
- **`skill-activated`**: when a skill's `activate-paths` matches a Read, inject its body once.
- **custom**: `reminders.custom("ci-mode", "You are running in CI; do NOT push to main.")` — fires every N turns.

Plus, the `Edit` tool's "old_string is not unique" error lists every match with line + col + one-line context (capped at 5, with a "more" marker when applicable) so the model can pick the disambiguation it needs without another Read round-trip.

```ts
import { createForgeAgent, reminders } from "@naaive/forge";

createForgeAgent({
  reminders: [
    reminders.custom("style-rule", "Match the existing 2-space indent in this repo.", 5),
  ],
});
```

## Hooks

```ts
createForgeAgent({
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

Settings are merged from `~/.forge/settings.json` → `<repo>/.forge/settings.json` → `<repo>/.forge/settings.local.json` (later overrides earlier).

## MCP

We use `@langchain/mcp-adapters` (LangChain's official MCP client) — no need to reinvent the protocol layer. The package exposes a thin wrapper:

```ts
import { createForgeAgent, setupMcpServers } from "@naaive/forge";

const mcp = await setupMcpServers({
  slack: { command: "npx", args: ["-y", "@modelcontextprotocol/server-slack"] },
  github: { command: "npx", args: ["-y", "@modelcontextprotocol/server-github"] },
});

const { agent } = createForgeAgent({
  // MCP tools land in the deferred registry — system prompt only lists names,
  // schemas are loaded via ToolSearch when the model needs them.
  deferredTools: mcp.tools,
  mcpClient: mcp.client,
});

try { await agent.invoke({ messages }) } finally { await mcp.stop() }
```

`@langchain/mcp-adapters` is an **optional peer dependency** — only install it when you actually use MCP.

## Multi-tier compaction

LangChain's official `summarizationMiddleware` is a one-trick blunt instrument — it just LLM-summarizes when context fills up. Forge runs a graduated, lossless-first cascade:

```
T0 time-gap microcompact   on long idle   · lossless     · cache cold anyway → keep last 1 round, stub the rest
T1 microcompact            every turn     · lossless     · old ToolMessage bodies → "[evicted; ...]" stub (Read can refetch)
T2 dedup tool_results      every turn     · lossless     · identical tool_results → "[same as tool_use_<id>]"
T3 aged-media strip        every turn     · recoverable  · image/PDF blocks past N rounds → text stub
T3.5 excess-media strip    every turn     · recoverable  · drop oldest media when total > 100 (Anthropic API hard cap)
T4 summarization           on threshold   · LOSSY        · fold oldest chunk into a SystemMessage; tool_use/tool_result pairs preserved
T5 pinning                 any tier       · —            · pinMessage(msg) protects from every tier
+ pairing-repair (always)  before model   · structural   · synthesize placeholders for orphan tool_use, drop orphan tool_result, dedup ids
```

Round boundaries follow the AIMessage `id` change, so streaming chunks share a round and single-prompt agentic sessions still group correctly. `recentRoundCutoff(n)` instead of "last N user turns" — fixes the use case where one human prompt produces many API rounds.

After any tier fires, a `<system-reminder name="compaction-applied">` block is appended to the next user message so the model knows what was preserved.

```ts
import { createForgeAgent, pinMessage } from "@naaive/forge";
import { HumanMessage } from "langchain";

// Pin the spec doc so it survives every compaction.
const spec = pinMessage(new HumanMessage("# API Spec\n\n..."));

const { agent } = createForgeAgent({
  summarization: {
    microcompactKeepRecent: 8,
    dedupeToolResults: true,
    agedMediaStripTurns: 6,
    triggerTokens: 80_000,
    keepTail: 16,
    chunkFraction: 0.4,
    summarize: async msgs => {
      const reply = await myLLM.invoke([
        new SystemMessage("Summarize succinctly..."),
        ...msgs,
      ]);
      return typeof reply.content === "string" ? reply.content : "";
    },
    onCompact: ev => console.log(`${ev.tier}: -${ev.beforeTokens - ev.afterTokens} tokens`),
  },
});

await agent.invoke({ messages: [spec, new HumanMessage("Implement endpoint /users")] });
```

Boundary safety: T4 never cuts between an `AIMessage` with `tool_calls` and the matching `ToolMessage`s — the boundary is slid forward to the next safe spot.

## Tests

```bash
bun test
```

The pure modules (tool registry, prompt assembly, fs helpers, glob regex, html→text, persistent-shell contract, reminder factories, settings merge, project-memory loader, permission classification, NotebookEdit semantics) are unit-tested.

## Project layout

```
src/
  agent.ts              entrypoint — createForgeAgent
  prompt.ts             system prompt assembly + cache-block split
  memory.ts             AGENTS.md project-memory loader
  env.ts                cwd / git / platform snapshot
  settings.ts           ~/.forge + .forge/ settings merge
  permissionMode.ts     plan / acceptEdits / bypass classifier
  permissionRules.ts    per-tool / per-arg pattern rules
  outputStyles.ts       concise / explanatory / learning + custom
  errors.ts             ConfigurationError, HookFailureError

  agent/                tool list + middleware chain assembly
  tools/                Bash, Read, Write, Edit, Grep, ... + shared registries
  middleware/           context-engineering, hooks, permissions, summarization, ...
  skills/               Agent Skills (SKILL.md) loader + activation
  commands/             custom slash commands (.forge/commands/)
  mcp/                  thin wrapper over @langchain/mcp-adapters
  lib/                  pure helpers (glob, html→text, message utils, ...)
```

# @claude-code-best/cc-on-langchain

**A Claude-Code-grade harness built directly on `langchain.createAgent`.**

Tool names, system prompt structure, prompt-cache strategy, system-reminder injection, permission modes, and tool semantics are all aligned with `claude-code` v1.11.x. No `deepagents` wrapper — its in-state filesystem and one-shot bash were too far from cc's contract to layer on top of.

## What we reuse from langchain (vs. what we built ourselves)

| Layer                          | Source                                                                              |
| ------------------------------ | ----------------------------------------------------------------------------------- |
| Agent loop                     | `createAgent` from `langchain`                                                      |
| Middleware framework           | `createMiddleware`, `AgentMiddleware` from `langchain`                              |
| Tool factory                   | `tool()` + `StructuredTool` / `ClientTool` / `ServerTool` from `@langchain/core`    |
| Messages                       | `SystemMessage` / `HumanMessage` / `ToolMessage` / `BaseMessage` from `langchain`   |
| Models                         | `LanguageModelLike` from `@langchain/core/language_models/base`                     |
| State updates                  | `Command` from `@langchain/langgraph`                                               |
| Checkpointer / Store           | `BaseCheckpointSaver` / `BaseStore` from `@langchain/langgraph-checkpoint` (passthrough) |
| Conversation prompt cache      | `anthropicPromptCachingMiddleware` from `langchain` (we add system-tail markers on top) |
| Human-in-the-loop approval     | `humanInTheLoopMiddleware` from `langchain` (`interruptOn` param)                   |
| Summarization (opt-in)         | `summarizationMiddleware` from `langchain` (`preferLangchainSummarization: true`)   |
| MCP                            | `@langchain/mcp-adapters` (peer dep) via `setupMcpServers` thin wrapper             |

Things we built from scratch — langchain has no equivalent and cc's contract is non-negotiable:

| Component                  | Why custom                                                                                  |
| -------------------------- | -------------------------------------------------------------------------------------------- |
| Real-disk fs tools         | langchain has no fs tools; cc edits real files with mtime stale-edit guard                   |
| `PersistentShell` + bg jobs | `cd`/exports persist across calls; BashOutput/KillShell registry                             |
| `DeferredToolRegistry` + ToolSearch | cc-style on-demand schema loading                                                  |
| `ResultStore` + eviction   | `ccx-store://` swap-out for oversized tool results                                           |
| Permission modes + rules   | cc's plan/acceptEdits/bypass + per-tool / per-arg pattern rules                              |
| `<system-reminder>` engine | Per-turn todo state / plan banner / skill activation injection                               |
| Skills loader              | Anthropic Agent Skills spec (SKILL.md frontmatter)                                            |
| Prompt cache (system tail) | Anthropic-API breakpoints on identity / behavior / env tiers                                 |
| Output styles              | cc presets (concise / explanatory / learning) + custom registry                              |
| Path recovery              | "Did you mean ...?" Levenshtein + cwd basename walk                                           |
| Truncation policy          | Per-tool refine-query / page-next / generic hints                                            |
| TodoWrite tool             | langchain's `todoListMiddleware` uses `write_todos`; we need PascalCase `TodoWrite`           |
| Hooks (5 events)           | Inline JS + shell-command hooks (cc's settings.json hook format)                              |

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
| **Deferred tools**     | `ToolSearch` loads schemas for tools the model knows by name only. The system prompt lists deferred-tool names; full JSONSchemas are returned on demand. Saves ~k tokens per request when many tools are present. |
| **File-unchanged stub** | Re-`Read`ing a file whose mtime hasn't changed returns a one-line stub directing the model to refer back to the earlier tool result. Identical to cc's `FILE_UNCHANGED_STUB`.                                  |
| **Tool result eviction** | Tool outputs above ~32KB are stashed in a `ResultStore`; the model sees a `[evicted; ${size}KB stored as ${id} — Read ccx-store://${id}]` stub and can pull the full content back via Read on demand.        |
| **Per-tool truncation** | Centralized policy: Grep/Glob/Bash truncate inline + emit "refine your query"; Read truncates + emits "use a higher offset"; everything else falls back to a generic hint.                                     |
| **Skills**             | Anthropic Agent Skills format. `~/.claude/skills/<name>/SKILL.md` and `<repo>/.claude/skills/<name>/SKILL.md` are loaded (project shadows user). The `DiscoverSkills` and `Skill` tools expose them on demand. |
| **Denial tracking**    | When a tool call gets denied (plan-mode block, hook block, user reject), we fingerprint the call and short-circuit identical retries with "you already tried this; pick a different approach".                |
| **Auto-compact warning** | A reminder fires once when the conversation crosses ~75% of the summarization trigger, telling the model to wrap up loose ends before history collapses.                                                      |
| **SlashCommand tool**  | Opt-in (`exposeSlashCommandTool: true`). The model can call `/init`, `/compact`, `/memory`, `/mode` itself when appropriate.                                                                                  |
| **Output styles**      | `concise` (default), `explanatory`, `learning`, plus host-defined custom styles. Selected via `outputStyle: "..."` or settings.                                                                                  |
| **Fine-grained perms** | Per-tool + per-arg pattern allow/deny rules (`Bash command="rm -rf*"` deny; `Edit file_path="/etc/**"` deny). Glob match: `*`, `**`, `?`, `[abc]`, AND across fields, first match wins.                            |
| **additionalDirectories** | fs tools allowed beyond `cwd` for monorepo / scratch-dir use.                                                                                                                                              |
| **Path-recovery hints** | Read/Write/Edit ENOENT errors include "Did you mean ...?" suggestions (Levenshtein on the parent dir + basename walk under cwd).                                                                              |
| **CLAUDE.md freshness** | Each loaded memory entry is annotated `(snapshot from N days ago)` so the model knows whether conventions are fresh or stale.                                                                                  |
| **Image / PDF / Notebook in Read** | PNG/JPG/GIF/WEBP return as image content blocks (model sees them); PDF returns as document content block; .ipynb is rendered cell-by-cell with outputs.                                            |
| **Conditional skill activation** | Skill `activate-paths: src/auth/**, **/*.sql` triggers a one-shot reminder when Read touches a matching path.                                                                                          |
| **MCP**                | Pluggable via `@langchain/mcp-adapters`. `setupMcpServers({ slack: {...} })` returns langchain tools; pass them as `deferredTools` so the model loads MCP schemas only when it needs them.                       |
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

## Context engineering — what cc does and we copy

| Mechanism                  | Where to look                                                                |
| -------------------------- | ---------------------------------------------------------------------------- |
| `<system-reminder>` blocks | `middleware/contextEngineering.ts` + `middleware/reminders.ts`               |
| Per-turn todo re-injection | `ccReminders.todoState` (full list, every turn)                              |
| Plan-mode banner           | `ccReminders.planModeActive`                                                 |
| Stale-todo nudge           | `ccReminders.todoStaleNudge`                                                 |
| Auto-compact pre-warning   | `ccReminders.autoCompactWarning(getTokens, warnAt, triggerAt)`               |
| Token-budget summarization | `middleware/summarization.ts` (pluggable LLM summarizer)                     |
| Tool-result eviction       | `middleware/resultEviction.ts` + `tools/resultStore.ts`                      |
| File-unchanged stub        | `tools/readFile.ts` (`FILE_UNCHANGED_STUB`)                                  |
| Per-tool truncation policy | `tools/truncationPolicy.ts`                                                  |
| Deferred-tool registry     | `tools/deferredRegistry.ts` + `tools/toolSearch.ts`                          |
| Tool-denial tracking       | `middleware/denialTracking.ts`                                               |
| Skills (Agent Skills spec) | `skills/loader.ts` + `skills/skillTool.ts`                                   |
| 4-breakpoint prompt cache  | `middleware/promptCache.ts` + `prompt.ts#buildCacheableSystemBlocks`         |

Wiring is automatic — `createClaudeCodeAgent` plugs every layer into the middleware chain in cc's order:

```
hooks → permissionMode → denialTracking → resultEviction →
[tokenSnapshot] → contextEngineering → summarization → promptCache → anthropicCache
```

## MCP

We use `@langchain/mcp-adapters` (langchain's official MCP client) — no need to reinvent the protocol layer. The package exposes a thin wrapper:

```ts
import { createClaudeCodeAgent, setupMcpServers } from "@claude-code-best/cc-on-langchain";

const mcp = await setupMcpServers({
  slack: { command: "npx", args: ["-y", "@modelcontextprotocol/server-slack"] },
  github: { command: "npx", args: ["-y", "@modelcontextprotocol/server-github"] },
});

const { agent } = createClaudeCodeAgent({
  // MCP tools land in the deferred registry — system prompt only lists names,
  // schemas are loaded via ToolSearch when the model needs them.
  deferredTools: mcp.tools,
  mcpClient: mcp.client,
});

try { await agent.invoke({ messages }) } finally { await mcp.stop() }
```

`@langchain/mcp-adapters` is an **optional peer dependency** — only install it when you actually use MCP.

## Multi-tier compaction

The official langchain `summarizationMiddleware` is a one-trick blunt instrument — it just LLM-summarizes when context fills up. cc actually runs a graduated, lossless-first cascade. We replicate the policy:

```
T1 microcompact         every turn   · lossless     · old ToolMessage bodies → "[evicted; ...]" stub (Read can refetch)
T2 dedup tool_results   every turn   · lossless     · identical tool_results → "[same as tool_use_<id>]"
T3 aged-media strip     every turn   · recoverable  · image/PDF blocks past N turns → text stub
T4 summarization        on threshold · LOSSY        · fold oldest chunk into a SystemMessage; tool_use/tool_result pairs preserved
T5 pinning              any tier     · —            · pinMessage(msg) protects from every tier
```

After any tier fires, a `<system-reminder name="compaction-applied">` block is appended to the next user message so the model knows what was preserved.

```ts
import { createClaudeCodeAgent, pinMessage } from "@claude-code-best/cc-on-langchain";
import { HumanMessage } from "langchain";

// Pin the spec doc so it survives every compaction.
const spec = pinMessage(new HumanMessage("# API Spec\n\n..."));

const { agent } = createClaudeCodeAgent({
  summarization: {
    microcompactKeepRecent: 8,
    dedupeToolResults: true,
    agedMediaStripTurns: 6,
    triggerTokens: 80_000,
    keepTail: 16,
    chunkFraction: 0.4,
    summarize: async msgs => {
      // Plug in any LLM; default is an offline heuristic (no API key needed).
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
$ bun test
 207 pass
 0 fail
```

The pure modules (cc tool registry, prompt assembly, fs helpers, glob regex, html→text, persistent shell contract, reminder factories, settings merge, claudemd loader, permission classification, NotebookEdit semantics) are 100% unit-tested.

## Why this lives in its own package

The `cc` repo is a fork of Claude Code itself, written against the Anthropic SDK directly with all the harness specifics (Ink REPL, MCP, ACP, daemon, …). This package is the *opposite* experiment: take the same tool surface and prompt structure but rebuild on `langchain.createAgent` to compare what it costs to drop into the LangGraph ecosystem (streaming / Studio / checkpointers / multi-provider model abstraction) without losing cc-grade tool semantics.

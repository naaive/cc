# Agent guide

Project-level guidance for AI coding agents (and human contributors) working on Forge.

## What this project is

Forge is a coding-agent harness on top of `langchain.createAgent`. The library exports `createForgeAgent({ ... }) → { agent, shell, jobRegistry, ... }` and ships everything an agent loop needs: real-disk filesystem tools, a persistent shell, ripgrep grep, plan/permission modes, hooks, system reminders, multi-tier compaction, prompt cache markers, and an MCP adapter.

There is **no CLI / REPL bundled** — host applications drive the returned LangGraph however they like (streaming, checkpointer, Studio).

## Commands

```bash
bun install            # install deps
bun test               # run all tests (uses bun:test)
bun test src/__tests__/memory.test.ts   # run one file
bun run typecheck      # tsc --noEmit, must be zero errors
bun run test:all       # typecheck + test
```

## Conventions

- **TypeScript strict mode.** `bun run typecheck` must pass with zero errors.
- **No `as any` in production code.** Tests may use `as any` for mock data only.
- **2-space indent**, trailing commas, single quotes, no semicolons (matches existing files).
- **Default to no comments.** Only add a comment when the WHY is non-obvious (a hidden constraint, a workaround for a specific bug, an invariant that would surprise a reader).
- **Don't add abstractions for hypothetical future requirements.** Three similar lines is better than a premature helper.
- **Tool names are part of the API contract.** Centralised in `src/tools/toolNames.ts`. Adding a new tool means: descriptor in `TOOL_NAMES`, description in `TOOL_DESCRIPTIONS`, classification in `READ_ONLY_TOOL_SET` or `WRITE_TOOL_SET`, registration in `src/agent/buildTools.ts`, exports in `src/tools/index.ts`.

## Architecture map

| Concern                     | Where it lives                                          |
| --------------------------- | ------------------------------------------------------- |
| Public entrypoint           | `src/agent.ts` (`createForgeAgent`)                     |
| Tool list assembly          | `src/agent/buildTools.ts`                               |
| Middleware chain assembly   | `src/agent/buildMiddleware.ts`                          |
| System prompt — templates   | `src/prompt.ts` (static sections, env builder)          |
| System prompt — composition | `src/agent/systemPromptAssembly.ts` (single entry point) |
| AGENTS.md loader            | `src/memory.ts`                                         |
| Settings merge              | `src/settings.ts`                                       |
| Permission gate             | `src/permission.ts` (one decision layer, mode + rules)  |
| Tool registry / names       | `src/tools/toolNames.ts`                                |
| Built-in tools              | `src/tools/*.ts`                                        |
| Read/Edit/Write/NotebookEdit seam | `src/tools/fileStateGuard.ts`                     |
| Persistent shells (Bash + PowerShell) | `src/tools/persistentShell.ts` (`BasePersistentShell`) |
| Compaction tiers (T0–T4)    | `src/middleware/compactors.ts`                          |
| Compaction orchestrator     | `src/middleware/summarization.ts`                       |
| Middleware                  | `src/middleware/*.ts`                                   |
| Skills (Agent Skills spec)  | `src/skills/*.ts`                                       |
| Slash commands              | `src/commands/*.ts`                                     |
| Discoverable-module helpers | `src/lib/discoverableModule.ts` (shared by Skills + Commands) |
| MCP adapter                 | `src/mcp/index.ts`                                      |
| Pure helpers                | `src/lib/*.ts`                                          |

The middleware chain runs in the order documented in `agent/buildMiddleware.ts` — that order is load-bearing, don't reshuffle without understanding the data flow.

## Core concepts

A few load-bearing names. Use them consistently when adding code.

- **PermissionGate** (`src/permission.ts`) — single decision function `evaluatePermission({ mode, toolName, args, rules, extraReadOnly })` returning a `PermissionDecision`. Coarse mode (`plan`/`bypassPermissions`/…) and per-tool/per-arg rules are evaluated together; rules win first so `deny Bash command="rm -rf*"` fires even under `bypassPermissions`. Don't reach into the underlying classifier or rule matcher from outside this file.
- **PermissionContext** (`src/permission.ts`) — read-side companion to the gate. Tools and reminders that want to ask "what would the gate say?" outside `wrapToolCall` consume a context built via `createPermissionContext({ getMode, getRules, extraReadOnly })`. Mode mutation stays in the middleware; mode reads go through this context.
- **FileStateGuard** (`src/tools/fileStateGuard.ts`) — single deep seam every fs tool calls into. Owns path resolution (absolute-only), boundary enforcement against cwd + `additionalDirectories`, the read-before-edit invariant, the mtime-fresh check, the `forge-store://` storage-URI restoration, the `FILE_UNCHANGED_STUB` short-circuit, and ENOENT path-recovery hints. The interface is three methods (`prepareRead`, `prepareEdit`, `prepareWrite`) plus `record`; tools never touch `FileStateCache` or `ResultStore` directly.
- **BasePersistentShell** (`src/tools/persistentShell.ts`) — the lifecycle, busy-flag, sentinel run loop, output cap, and `lastCwd` tracking shared by `PersistentShell` (Bash) and `PersistentPowerShell` (pwsh). Each subclass supplies a `ShellSpec` (binary, spawn args, env extras, command-wrapping). The `HasLastCwd` interface is the seam reminders consume — never type-check on the concrete class.
- **Compactor** (`src/middleware/compactors.ts`) — one tier, one factory. `summarization.ts` builds the list (T0 idle → T1 micro → T2 dedupe → T3 aged-media → T3.5 excess-media → T4 summarize) and orchestrates them. Adding a tier means adding a `create*Compactor()` and slotting it into the list — never reach into the orchestrator's loop.
- **DiscoverableModule** (`src/lib/discoverableModule.ts`) — shared `ModuleSource`, size cap, and project-shadows-user dedup used by both `src/skills/loader.ts` and `src/commands/loader.ts`. A bug in dedup or the size cap is fixed once.
- **PromptSection** (`src/agent/systemPromptAssembly.ts`) — the appendix is a list of `{ name, render() }` sections (host-appendix, deferred-tools, skills, output-style). A new appendix block adds a section here without touching `composeAppendix`.
- **ReminderStore** (`src/middleware/reminders.ts`) — per-reminder state pocket handed to each `Reminder.shouldFire(ctx)`. Two reminders can use the same key (`lastTurn`) with no risk of collision; `createReminderStore(state, name)` does the namespacing. Cooldown-style reminders share a `shouldFireOnInterval(ctx, n)` helper so the throttle logic isn't hand-rolled per reminder.
- **assembleSystemPrompt** (`src/agent/systemPromptAssembly.ts`) — the only function that decides what the model sees. `prompt.ts` is a template library; never compose a prompt by hand-concatenating its sections.

## Testing rules

- Unit tests live in `src/__tests__/*.test.ts`.
- Use `bun:test` (built-in mock + assertions).
- Use real temp dirs (`fs.mkdtempSync(path.join(os.tmpdir(), 'forge-…'))`) for fs tests; clean up in `afterEach`.
- `MemoryEntry` requires `mtimeMs` — pass `Date.now()` in mock fixtures.
- Don't mock pure helpers; only mock things with side effects (network, child processes).

## Commit messages

Conventional Commits, English or 中文 OK:

```
<type>: <description>

feat: 新增 something
fix: 修复 something
docs: 更新 README
chore: bump deps
refactor: simplify foo
```

## Don'ts

- Don't add a CLI / REPL — Forge is a library.
- Don't introduce a runtime other than Bun for tests; Bun is the dev/test runner.
- Don't add new top-level config files (vite, biome, etc.) — `tsconfig.json` + `package.json` are the whole story.
- Don't paraphrase tool descriptions in `toolNames.ts` casually — model behaviour is sensitive to phrasing.
- Don't bypass `PersistentShell` by running raw `child_process.exec` from a tool; the persistent shell is the contract.

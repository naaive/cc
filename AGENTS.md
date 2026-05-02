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

| Concern                     | Where it lives                                      |
| --------------------------- | --------------------------------------------------- |
| Public entrypoint           | `src/agent.ts` (`createForgeAgent`)                 |
| Tool list assembly          | `src/agent/buildTools.ts`                           |
| Middleware chain assembly   | `src/agent/buildMiddleware.ts`                      |
| System prompt               | `src/prompt.ts` + `src/agent/systemPromptAssembly.ts` |
| AGENTS.md loader            | `src/memory.ts`                                     |
| Settings merge              | `src/settings.ts`                                   |
| Permission classifier       | `src/permissionMode.ts`, `src/permissionRules.ts`   |
| Tool registry / names       | `src/tools/toolNames.ts`                            |
| Built-in tools              | `src/tools/*.ts`                                    |
| Middleware                  | `src/middleware/*.ts`                               |
| Skills (Agent Skills spec)  | `src/skills/*.ts`                                   |
| Slash commands              | `src/commands/*.ts`                                 |
| MCP adapter                 | `src/mcp/index.ts`                                  |
| Pure helpers                | `src/lib/*.ts`                                      |

The middleware chain runs in the order documented in `agent/buildMiddleware.ts` — that order is load-bearing, don't reshuffle without understanding the data flow.

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

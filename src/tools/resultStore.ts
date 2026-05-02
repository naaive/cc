/**
 * Tool-result eviction store.
 *
 * Large tool outputs blow up the conversation: a 200KB grep result lives
 * in the message history forever, gets re-sent every turn, gets cached
 * in vain (the cache prefix breaks the moment any later message is
 * appended). The mitigation:
 *
 *   1. Evict oversize tool results into an external store keyed by an
 *      opaque storage_id.
 *   2. Replace the tool_result content with a one-line stub:
 *      "[tool result evicted; ${kb}KB stored as storage_id=xxx — call
 *       Read with file_path=forge-store://xxx to retrieve]"
 *   3. The model can pull the full payload back on demand via a virtual
 *      `forge-store://<id>` path that Read recognises.
 *
 * Why an in-memory map is enough for now: tool results don't survive past
 * the agent process anyway (no LangGraph checkpoint serializes them by
 * default). When a host wants persistence across runs they can pass an
 * implementation backed by Redis / disk / SQLite.
 */

import { randomUUID } from 'node:crypto'

export interface StoredResult {
  id: string
  toolName: string
  size: number
  storedAt: number
  content: string
}

export interface ResultStore {
  put(toolName: string, content: string): StoredResult
  get(id: string): StoredResult | undefined
  size(): number
  clear(): void
}

export function createInMemoryResultStore(): ResultStore {
  const store = new Map<string, StoredResult>()
  return {
    put(toolName, content) {
      const id = `cs_${randomUUID().replace(/-/g, '').slice(0, 16)}`
      const entry: StoredResult = {
        id,
        toolName,
        size: content.length,
        storedAt: Date.now(),
        content,
      }
      store.set(id, entry)
      return entry
    },
    get(id) {
      return store.get(id)
    },
    size() {
      return store.size
    },
    clear() {
      store.clear()
    },
  }
}

/**
 * Tools that should NEVER be evicted.
 *
 * Excluded tools:
 *  - Tools with built-in truncation (Glob, Grep, LS — wait, we have no LS):
 *    if these get truncated, the right answer is a refined query, not a
 *    full-content fetch.
 *  - Tools that return small confirmations (Edit, Write).
 *  - Read: re-reading a truncated read of the same file isn't useful;
 *    the model should just request a different range.
 */
export const TOOLS_EXCLUDED_FROM_EVICTION: ReadonlySet<string> = new Set([
  'Glob',
  'Grep',
  'Read',
  'Edit',
  'Write',
  'NotebookEdit',
  // Bash output is interesting — large bash output IS worth evicting.
  // BashOutput / KillShell short results aren't.
  'BashOutput',
  'KillShell',
  // Plan-mode tool results are short.
  'ExitPlanMode',
  // TodoWrite returns no content.
  'TodoWrite',
  // ToolSearch results are inherently small (one schema each).
  'ToolSearch',
])

/**
 * Default eviction policy: tool results above this byte threshold get
 * stashed into the store and replaced with a stub. We use an approximate
 * token budget; we use a byte budget for the same effect (chars/4 ≈
 * tokens for English).
 */
export const DEFAULT_EVICT_BYTES = 32_000

export interface EvictionPolicy {
  evictBytes: number
  excluded: ReadonlySet<string>
}

export function buildEvictionStub(stored: StoredResult): string {
  const kb = (stored.size / 1024).toFixed(1)
  return `[tool result evicted; ${kb}KB stored as ${stored.id}. Read it back via Read with file_path="${storageUri(stored.id)}".]`
}

export const STORAGE_SCHEME = 'forge-store://'

export function storageUri(id: string): string {
  return `${STORAGE_SCHEME}${id}`
}

export function parseStorageUri(path: string): string | null {
  if (!path.startsWith(STORAGE_SCHEME)) return null
  return path.slice(STORAGE_SCHEME.length)
}

export function shouldEvict(
  toolName: string,
  resultLength: number,
  policy: EvictionPolicy,
): boolean {
  if (policy.excluded.has(toolName)) return false
  return resultLength >= policy.evictBytes
}

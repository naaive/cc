/**
 * Per-tool truncation policy.
 *
 * cc applies different truncation strategies per tool because the right
 * "what to do when output is huge" answer depends on the tool's nature:
 *
 *   - Glob / Grep / Bash output: TRUNCATE inline + append a "refine your
 *     query" hint. Re-reading more matches doesn't help; the right move
 *     is a narrower pattern.
 *   - Read: TRUNCATE inline by paging — the model can ask for the next
 *     page via offset/limit. NEVER evict (eviction would force a re-read,
 *     which gives no new information).
 *   - Most others: leave alone, let the eviction middleware handle it.
 *
 * The truncation hints come straight from cc's `prependBullets` style:
 * short, declarative, action-oriented.
 */

const HINT_REFINE_QUERY =
  'Output truncated. The query likely matches too broadly — refine it (more specific pattern, narrower path, file glob, head_limit) instead of fetching more.'

const HINT_PAGE_NEXT =
  'Output truncated. Call this tool again with a higher `offset` (and the same `limit`) to read the next page.'

const HINT_GENERIC =
  'Output truncated. Reduce the scope or read the result via Read with the storage_id if it was evicted.'

export interface TruncationDecision {
  text: string
  truncated: boolean
}

export interface TruncationPolicy {
  /** Truncate `text` to at most `max` chars and append a tool-appropriate hint. */
  apply(toolName: string, text: string, max: number): TruncationDecision
}

export function createTruncationPolicy(): TruncationPolicy {
  return {
    apply(toolName, text, max) {
      if (text.length <= max) return { text, truncated: false }
      const sliced = text.slice(0, max)
      const hint = pickHint(toolName)
      return {
        text: `${sliced}\n\n[truncated to ${max} chars]\n${hint}`,
        truncated: true,
      }
    },
  }
}

function pickHint(toolName: string): string {
  switch (toolName) {
    case 'Glob':
    case 'Grep':
    case 'Bash':
    case 'BashOutput':
      return HINT_REFINE_QUERY
    case 'Read':
      return HINT_PAGE_NEXT
    default:
      return HINT_GENERIC
  }
}

/**
 * Prompt-cache middleware — 4-breakpoint Anthropic caching strategy.
 *
 * Anthropic's prompt cache lets you mark up to FOUR positions with
 * `cache_control: { type: "ephemeral" }`. The server caches everything
 * BEFORE the marker; the next request that matches the prefix gets a
 * 90% discount on those tokens. The strategy:
 *
 *   marker 1: end of system prompt (identity + behavior — most stable)
 *   marker 2: end of system prompt + tool definitions (changes per-binary)
 *   marker 3: end of conversation history minus the last 2 turns
 *             (turn history accumulates; this rolls forward)
 *   marker 4: end of the LAST user message
 *             (lets the next turn re-hit cache for everything up through
 *             the previous user reply)
 *
 * langchain provides `anthropicPromptCachingMiddleware` which handles the
 * conversation/last-message side. We layer this middleware on top to add
 * the system-prompt and tool-definition markers, since langchain's helper
 * doesn't touch those.
 *
 * Implementation strategy: we mutate `state.messages[0]` (the system
 * SystemMessage) so its content becomes a list of content blocks with
 * a cache_control on the last block. langchain's caching middleware picks
 * up the marker we set and adds the conversation-side markers itself.
 */

import {
  createMiddleware,
  SystemMessage,
  type AgentMiddleware,
  type BaseMessage,
} from 'langchain'

export interface PromptCacheMiddlewareOptions {
  /** Mark the system prompt's tail as cache_control: ephemeral. Default true. */
  cacheSystem?: boolean
  /** Number of trailing user/assistant turns to NOT cache (so they roll). Default 2. */
  rollingTurns?: number
  /**
   * Use the 1h extended TTL when the model supports it (only Claude 4.5+
   * and the upgraded 3.7 family right now). Off by default — the 5min
   * default TTL is enough for interactive use.
   */
  extendedTtl?: boolean
}

const stateSchema = undefined

export function createPromptCacheMiddleware(
  options: PromptCacheMiddlewareOptions = {},
): AgentMiddleware {
  const cacheSystem = options.cacheSystem ?? true
  const rollingTurns = options.rollingTurns ?? 2
  const ttl = options.extendedTtl ? '1h' : '5m'

  return createMiddleware({
    name: 'PromptCacheMiddleware',
    stateSchema,
    beforeModel: (state: { messages: BaseMessage[] }) => {
      if (state.messages.length === 0) return undefined
      const messages = [...state.messages]

      // Marker on the system message tail.
      if (cacheSystem) {
        const idx = messages.findIndex(m => m.getType() === 'system')
        if (idx >= 0) {
          messages[idx] = withSystemCacheControl(messages[idx]!, ttl)
        }
      }

      // Marker on the last user message before the rolling tail.
      // We attach it to the message at position (length - rollingTurns - 1)
      // when one exists. langchain's anthropic caching middleware handles
      // the very-last-message marker; this middleware handles the one
      // BEFORE the rolling tail so the cache "anchors" forward predictably.
      const anchorIdx = messages.length - rollingTurns - 1
      if (anchorIdx >= 0) {
        const anchor = messages[anchorIdx]!
        if (anchor.getType() !== 'system') {
          messages[anchorIdx] = withTailCacheControl(anchor, ttl)
        }
      }

      return { messages }
    },
  })
}

interface CacheBlock {
  type: 'text'
  text: string
  cache_control?: { type: 'ephemeral'; ttl?: '5m' | '1h' }
}

function withSystemCacheControl(
  msg: BaseMessage,
  ttl: '5m' | '1h',
): BaseMessage {
  // langchain SystemMessage content can be string or content blocks.
  const blocks = toContentBlocks(msg)
  if (blocks.length === 0) return msg
  blocks[blocks.length - 1] = {
    ...blocks[blocks.length - 1]!,
    cache_control: { type: 'ephemeral', ttl },
  }
  return new SystemMessage({ content: blocks as unknown as string })
}

function withTailCacheControl(
  msg: BaseMessage,
  ttl: '5m' | '1h',
): BaseMessage {
  const blocks = toContentBlocks(msg)
  if (blocks.length === 0) return msg
  blocks[blocks.length - 1] = {
    ...blocks[blocks.length - 1]!,
    cache_control: { type: 'ephemeral', ttl },
  }
  // Mutate in place — preserves the original message subclass / metadata.
  ;(msg as unknown as { content: unknown }).content = blocks
  return msg
}

function toContentBlocks(msg: BaseMessage): CacheBlock[] {
  const c = msg.content as unknown
  if (typeof c === 'string') {
    return c.length > 0 ? [{ type: 'text', text: c }] : []
  }
  if (Array.isArray(c)) {
    return c.map(part => {
      if (typeof part === 'string') return { type: 'text', text: part }
      if (
        part &&
        typeof part === 'object' &&
        'type' in part &&
        (part as { type: unknown }).type === 'text' &&
        'text' in part &&
        typeof (part as { text: unknown }).text === 'string'
      ) {
        const p = part as { text: string; cache_control?: CacheBlock['cache_control'] }
        return p.cache_control
          ? { type: 'text', text: p.text, cache_control: p.cache_control }
          : { type: 'text', text: p.text }
      }
      return { type: 'text', text: '' }
    })
  }
  return []
}

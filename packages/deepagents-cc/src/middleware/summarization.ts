/**
 * Multi-tier compaction — cc-style.
 *
 * The official langchain `summarizationMiddleware` is too coarse: it just
 * asks the LLM to summarize when the context is full. cc's strategy is
 * graduated, lossless-first, with the lossy summarizer as last resort:
 *
 *   T1  Microcompact (every turn, lossless)
 *       Old `ToolMessage`s past `microcompactKeepRecent` get their content
 *       replaced with a one-line stub. The original content is already in
 *       the ResultStore (or can be re-fetched), so the model can Read it
 *       back when needed.
 *
 *   T2  Tool-result deduplication (every turn, lossless)
 *       Hash each ToolMessage content. Second + occurrences become
 *       `[same as tool_use_<id>]` referring to the first occurrence.
 *
 *   T3  Aged-media strip (every turn, recoverable)
 *       Image / document content blocks in messages older than
 *       `agedMediaStripTurns` are replaced with a one-line text stub.
 *       The original file is still on disk (or in the store), so the model
 *       can Read it again if it really needs the pixels.
 *
 *   T4  Summarization (when token budget exceeded, lossy)
 *       Summarize the OLDEST chunk (default 40% of compactable region) into
 *       a single SystemMessage. Keep `keepTail` recent turns verbatim.
 *       Boundary check: NEVER split a tool_use from its tool_result.
 *
 *   T5  Pinning (any tier)
 *       Messages marked `additional_kwargs.__pinned = true` are never
 *       touched by T1-T4. Use this for the "always remember the spec doc"
 *       pattern.
 *
 * After any tier fires, a `<system-reminder>` is appended to the next user
 * message explaining what was preserved.
 */

import {
  AIMessage,
  createMiddleware,
  HumanMessage,
  SystemMessage,
  ToolMessage,
  type AgentMiddleware,
  type BaseMessage,
} from 'langchain'
import { z } from 'zod/v4'
import {
  djb2,
  isMessagePinned as isPinned,
  roughTokenCount,
  stringifyContent,
} from '../lib/messageUtils.js'

export { isMessagePinned, pinMessage, roughTokenCount } from '../lib/messageUtils.js'

export interface SummarizationMiddlewareOptions {
  /** T1: keep tool_results from at least this many recent turns intact. */
  microcompactKeepRecent?: number
  /** T2: enable tool-result deduplication. */
  dedupeToolResults?: boolean
  /** T3: strip image/document blocks older than this many turns. */
  agedMediaStripTurns?: number
  /** T4: trigger summarization when rough tokens exceed this. */
  triggerTokens?: number
  /** T4: keep at least this many trailing messages verbatim. */
  keepTail?: number
  /** T4: fraction of the compactable region to fold per pass (0 < x ≤ 1). */
  chunkFraction?: number
  /** T4: pluggable summarizer. Returns the summary text. */
  summarize?: (messages: BaseMessage[]) => Promise<string>
  /** Telemetry / debug. */
  onCompact?: (info: CompactionEvent) => void
}

export interface CompactionEvent {
  tier: 'T1' | 'T2' | 'T3' | 'T4'
  beforeTokens: number
  afterTokens: number
  /** Per-tier details (e.g. number of ToolMessages stubbed). */
  details: Record<string, unknown>
}

const stateSchema = z.object({
  __compactionLog: z
    .array(
      z.object({
        tier: z.string(),
        at: z.number(),
        beforeTokens: z.number(),
        afterTokens: z.number(),
      }),
    )
    .default([]),
})

export function createSummarizationMiddleware(
  options: SummarizationMiddlewareOptions = {},
): AgentMiddleware {
  const microKeep = options.microcompactKeepRecent ?? 8
  const agedMedia = options.agedMediaStripTurns ?? 6
  const trigger = options.triggerTokens ?? 80_000
  const keepTail = options.keepTail ?? 16
  const chunkFraction = clamp01(options.chunkFraction ?? 0.4)
  const dedupe = options.dedupeToolResults ?? true
  const summarize = options.summarize ?? heuristicSummary

  return createMiddleware({
    name: 'CompactionMiddleware',
    stateSchema,
    beforeModel: async (state: {
      messages: BaseMessage[]
      __compactionLog?: CompactionEvent[]
    }) => {
      const events: CompactionEvent[] = []
      let messages = state.messages
      const before = roughTokenCount(messages)

      // T1: microcompact — proactive eviction of old tool_result bodies.
      const t1 = microcompact(messages, microKeep)
      if (t1.changed) {
        const after = roughTokenCount(t1.messages)
        events.push({
          tier: 'T1',
          beforeTokens: before,
          afterTokens: after,
          details: { stubbed: t1.stubbed },
        })
        messages = t1.messages
      }

      // T2: deduplicate tool_results.
      if (dedupe) {
        const t2 = dedupeToolMessages(messages)
        if (t2.changed) {
          const t2Before = events.at(-1)?.afterTokens ?? before
          const t2After = roughTokenCount(t2.messages)
          events.push({
            tier: 'T2',
            beforeTokens: t2Before,
            afterTokens: t2After,
            details: { deduped: t2.deduped },
          })
          messages = t2.messages
        }
      }

      // T3: strip aged media payloads.
      const t3 = stripAgedMedia(messages, agedMedia)
      if (t3.changed) {
        const t3Before = events.at(-1)?.afterTokens ?? before
        const t3After = roughTokenCount(t3.messages)
        events.push({
          tier: 'T3',
          beforeTokens: t3Before,
          afterTokens: t3After,
          details: { stripped: t3.stripped },
        })
        messages = t3.messages
      }

      // T4: summarize the oldest chunk when still over budget.
      const tokensNow = events.at(-1)?.afterTokens ?? before
      if (tokensNow >= trigger && messages.length > keepTail + 1) {
        const t4 = await summarizeChunk(messages, keepTail, chunkFraction, summarize)
        if (t4.changed) {
          const t4After = roughTokenCount(t4.messages)
          events.push({
            tier: 'T4',
            beforeTokens: tokensNow,
            afterTokens: t4After,
            details: { droppedMessages: t4.dropped, summaryChars: t4.summaryChars },
          })
          messages = t4.messages
        }
      }

      if (events.length === 0) return undefined

      for (const ev of events) options.onCompact?.(ev)

      // Append a system-reminder to the next user message describing the
      // compaction so the model knows what was preserved.
      messages = appendCompactionReminder(messages, events)

      const log = state.__compactionLog ?? []
      const newLog = [
        ...log,
        ...events.map(e => ({
          tier: e.tier,
          at: Date.now(),
          beforeTokens: e.beforeTokens,
          afterTokens: e.afterTokens,
        })),
      ].slice(-16)

      return { messages, __compactionLog: newLog }
    },
  })
}

// ────────────────────────────────────────────────────────────── helpers

const TOOL_RESULT_STUB =
  '[evicted by microcompact — original content was a tool result; refer to earlier conversation summary or re-run the tool]'

const MEDIA_STUB =
  '[aged media stripped — original was an image/document attachment; Read the file again if you need it]'

/**
 * T1: microcompact.
 *
 * Walk messages from oldest to newest. For each `ToolMessage` that's
 * NOT in the last `keepRecent` turns and NOT pinned, replace its content
 * with the stub. Track a count for the event.
 *
 * "Turn" = one user message + the assistant response + tool_results.
 * We approximate by counting the last `keepRecent` HumanMessages and
 * keeping everything from the earliest of those forward.
 */
function microcompact(
  messages: BaseMessage[],
  keepRecent: number,
): { changed: boolean; messages: BaseMessage[]; stubbed: number } {
  const cutoffIdx = recentTurnCutoff(messages, keepRecent)
  let changed = false
  let stubbed = 0
  const out = messages.map((m, i) => {
    if (i >= cutoffIdx) return m
    if (isPinned(m)) return m
    if (!(m instanceof ToolMessage)) return m
    if (typeof m.content === 'string' && m.content.startsWith('[evicted')) return m
    changed = true
    stubbed++
    return new ToolMessage({
      content: TOOL_RESULT_STUB,
      tool_call_id: m.tool_call_id,
      name: m.name,
      status: m.status,
    })
  })
  return { changed, messages: out, stubbed }
}

/**
 * T2: tool-result deduplication. Identical content (after stubbing) gets
 * collapsed to `[same as <prior_tool_use_id>]`.
 */
function dedupeToolMessages(
  messages: BaseMessage[],
): { changed: boolean; messages: BaseMessage[]; deduped: number } {
  const seen = new Map<string, string>() // hash → first tool_call_id
  let changed = false
  let deduped = 0
  const out = messages.map(m => {
    if (!(m instanceof ToolMessage)) return m
    if (isPinned(m)) return m
    const text = typeof m.content === 'string' ? m.content : ''
    if (text.length === 0) return m
    if (text.startsWith('[same as') || text.startsWith('[evicted') || text.startsWith('[aged')) {
      return m
    }
    const hash = djb2(text)
    const first = seen.get(hash)
    if (first && first !== m.tool_call_id) {
      changed = true
      deduped++
      return new ToolMessage({
        content: `[same as tool_use_${first}]`,
        tool_call_id: m.tool_call_id,
        name: m.name,
        status: m.status,
      })
    }
    if (!first) seen.set(hash, m.tool_call_id)
    return m
  })
  return { changed, messages: out, deduped }
}

/**
 * T3: strip aged image/document content blocks. Replaces the heavy block
 * with a one-line text stub but keeps the rest of the message intact.
 */
function stripAgedMedia(
  messages: BaseMessage[],
  ageTurns: number,
): { changed: boolean; messages: BaseMessage[]; stripped: number } {
  const cutoffIdx = recentTurnCutoff(messages, ageTurns)
  let changed = false
  let stripped = 0
  const out = messages.map((m, i) => {
    if (i >= cutoffIdx) return m
    if (isPinned(m)) return m
    if (!Array.isArray(m.content)) return m
    let any = false
    const next = m.content.map(part => {
      if (
        part &&
        typeof part === 'object' &&
        'type' in part &&
        ((part as { type: string }).type === 'image' ||
          (part as { type: string }).type === 'document')
      ) {
        any = true
        stripped++
        return { type: 'text', text: MEDIA_STUB }
      }
      return part
    })
    if (!any) return m
    changed = true
    // Reconstruct via .constructor so AIMessage stays AIMessage etc.
    const Ctor = (m as unknown as { constructor: new (args: { content: unknown }) => BaseMessage }).constructor
    return new Ctor({ content: next })
  })
  return { changed, messages: out, stripped }
}

/**
 * T4: summarize the oldest chunk.
 *
 * Slice the compactable region [0..messages.length-keepTail). Pick a chunk
 * of `chunkFraction` of those messages, ALIGNED to a tool_use/tool_result
 * boundary so we never break a pair. Send it to the summarizer; replace
 * with a single SystemMessage.
 */
async function summarizeChunk(
  messages: BaseMessage[],
  keepTail: number,
  chunkFraction: number,
  summarize: (msgs: BaseMessage[]) => Promise<string>,
): Promise<{
  changed: boolean
  messages: BaseMessage[]
  dropped: number
  summaryChars: number
}> {
  const compactableEnd = Math.max(0, messages.length - keepTail)
  if (compactableEnd <= 0) return { changed: false, messages, dropped: 0, summaryChars: 0 }
  const desiredEnd = Math.max(1, Math.floor(compactableEnd * chunkFraction))
  // Adjust forward to a safe boundary: don't split a tool_use from its tool_result.
  const safeEnd = nextSafeBoundary(messages, desiredEnd, compactableEnd)
  if (safeEnd <= 0) return { changed: false, messages, dropped: 0, summaryChars: 0 }

  // Don't summarize already-pinned messages — slice them out and reinsert.
  const compactable: BaseMessage[] = []
  const preserved: BaseMessage[] = []
  for (let i = 0; i < safeEnd; i++) {
    const m = messages[i]!
    if (isPinned(m)) preserved.push(m)
    else compactable.push(m)
  }
  if (compactable.length === 0) {
    return { changed: false, messages, dropped: 0, summaryChars: 0 }
  }

  const summaryText = await summarize(compactable)
  const summaryMessage = new SystemMessage(
    `[earlier conversation summary, ${compactable.length} messages]\n${summaryText}`,
  )
  const out = [...preserved, summaryMessage, ...messages.slice(safeEnd)]
  return {
    changed: true,
    messages: out,
    dropped: compactable.length,
    summaryChars: summaryText.length,
  }
}

/**
 * Index of the first message in the most recent `n` user turns. Anything
 * BEFORE this index is "old" (eligible for microcompact / aged-media strip).
 */
function recentTurnCutoff(messages: BaseMessage[], n: number): number {
  if (n <= 0) return messages.length
  let count = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.getType() === 'human') {
      count++
      if (count >= n) return i
    }
  }
  return 0
}

/**
 * Slide forward from `desired` until we land on a position that doesn't
 * sit between an AIMessage that emitted tool_calls and its corresponding
 * ToolMessage(s). Returns `cap` if we can't find a clean break before then.
 */
function nextSafeBoundary(
  messages: BaseMessage[],
  desired: number,
  cap: number,
): number {
  let i = desired
  while (i < cap) {
    const prev = messages[i - 1]
    const here = messages[i]
    // If we're about to start with a ToolMessage, the tool_use that
    // produced it is in the previous AI message — slide forward.
    if (here instanceof ToolMessage) {
      i++
      continue
    }
    // If the previous message is an AI message with tool_calls and the
    // next message is a ToolMessage, we can't cut between them.
    if (
      prev instanceof AIMessage &&
      Array.isArray((prev as AIMessage).tool_calls) &&
      (prev as AIMessage).tool_calls!.length > 0 &&
      here instanceof ToolMessage
    ) {
      i++
      continue
    }
    return i
  }
  return cap
}

function appendCompactionReminder(
  messages: BaseMessage[],
  events: CompactionEvent[],
): BaseMessage[] {
  const lastUserIdx = lastIndexOfHuman(messages)
  if (lastUserIdx < 0) return messages
  const last = messages[lastUserIdx]!
  const summary = events
    .map(e => {
      const dt = Object.entries(e.details)
        .map(([k, v]) => `${k}=${String(v)}`)
        .join(', ')
      const delta = e.beforeTokens - e.afterTokens
      return `${e.tier}: -${delta} tokens (${dt})`
    })
    .join('; ')
  const reminder = `<system-reminder name="compaction-applied">Conversation was compacted: ${summary}. Earlier tool results may have been replaced with stubs — re-run the tool or Read the file if you need fresh data.</system-reminder>`
  const text = stringifyContent(last) + '\n\n' + reminder
  const next = new HumanMessage(text)
  const out = [...messages]
  out[lastUserIdx] = next
  return out
}

function lastIndexOfHuman(messages: BaseMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.getType() === 'human') return i
  }
  return -1
}

function clamp01(x: number): number {
  if (x <= 0) return 0.001
  if (x > 1) return 1
  return x
}

async function heuristicSummary(messages: BaseMessage[]): Promise<string> {
  const userTurns = messages.filter(m => m.getType() === 'human').length
  const aiTurns = messages.filter(m => m.getType() === 'ai').length
  const toolCalls = messages.filter(m => m instanceof ToolMessage).length
  const firstUser = messages.find(m => m.getType() === 'human')
  const firstUserText = firstUser ? stringifyContent(firstUser).slice(0, 200) : ''
  const lastAi = [...messages].reverse().find(m => m.getType() === 'ai')
  const lastAiText = lastAi ? stringifyContent(lastAi).slice(0, 200) : ''
  return [
    `Compacted ${messages.length} messages: ${userTurns} user, ${aiTurns} assistant, ${toolCalls} tool result(s).`,
    firstUserText && `First user request: ${firstUserText}…`,
    lastAiText && `Most recent assistant reply: ${lastAiText}…`,
  ]
    .filter(Boolean)
    .join('\n')
}

// Re-export the tier functions for unit testing. They're intentionally
// named with underscores to signal "internal but exposed for tests".
export {
  microcompact as _microcompact,
  dedupeToolMessages as _dedupeToolMessages,
  stripAgedMedia as _stripAgedMedia,
  nextSafeBoundary as _nextSafeBoundary,
  recentTurnCutoff as _recentTurnCutoff,
}

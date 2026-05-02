/**
 * Compactors — one per tier. Each is a small module with a stable
 * interface; the orchestrator in `summarization.ts` runs them in order.
 *
 * Tier guide:
 *
 *   T0   Time-gap microcompact (lossless)
 *        Aggressive eviction when the conversation has been idle long
 *        enough that the prompt cache is dead anyway.
 *   T1   Microcompact (every turn, lossless)
 *        Old `ToolMessage`s past `microcompactKeepRecent` get their content
 *        replaced with a one-line stub.
 *   T2   Tool-result deduplication (every turn, lossless)
 *        Identical tool results collapse to `[same as tool_use_<id>]`.
 *   T3   Aged-media strip (every turn, recoverable)
 *        Image/document blocks older than `agedMediaStripTurns` become text stubs.
 *   T3.5 Excess-media strip
 *        Anthropic's hard 100-block-per-request cap, enforced before we'd hit it.
 *   T4   Summarization (when token budget exceeded, lossy)
 *        Summarize the OLDEST chunk of the compactable region into one
 *        SystemMessage. Boundary check: NEVER split a tool_use from its
 *        tool_result.
 */

import {
  AIMessage,
  SystemMessage,
  ToolMessage,
  type BaseMessage,
} from 'langchain'
import {
  djb2,
  isMessagePinned as isPinned,
  recentRoundCutoff,
  stringifyContent,
} from '../lib/messageUtils.js'

export type CompactionTier = 'T0' | 'T1' | 'T2' | 'T3' | 'T3.5' | 'T4'

/**
 * The orchestrator hands each compactor a snapshot of the messages and
 * gets back either a transformation step or `null` (no-op).
 *
 * Tiers are pure-ish: T0–T3.5 are sync; T4 is async because it calls a
 * pluggable summarizer. The interface returns a Promise to accommodate
 * both without two parallel hierarchies.
 */
export interface Compactor {
  readonly tier: CompactionTier
  apply(messages: BaseMessage[]): Promise<CompactionStep | null> | CompactionStep | null
}

export interface CompactionStep {
  messages: BaseMessage[]
  details: Record<string, unknown>
}

const TOOL_RESULT_STUB =
  '[evicted by microcompact — original content was a tool result; refer to earlier conversation summary or re-run the tool]'

const MEDIA_STUB =
  '[aged media stripped — original was an image/document attachment; Read the file again if you need it]'

// ────────────────────────────────────────────────────────── microcompact (T0/T1)

/**
 * Walk messages from oldest to newest. For each `ToolMessage` that's
 * NOT in the last `keepRecent` rounds and NOT pinned, replace its content
 * with the stub.
 */
export function microcompact(
  messages: BaseMessage[],
  keepRecent: number,
): { changed: boolean; messages: BaseMessage[]; stubbed: number } {
  const cutoffIdx = recentRoundCutoff(messages, keepRecent)
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
 * T1 compactor — proactive eviction of old tool_result bodies on every turn.
 */
export function createMicrocompactor(keepRecent: number): Compactor {
  return {
    tier: 'T1',
    apply(messages) {
      const r = microcompact(messages, keepRecent)
      return r.changed ? { messages: r.messages, details: { stubbed: r.stubbed } } : null
    },
  }
}

/**
 * T0 compactor — fires only when the conversation has been idle longer
 * than `gapMs`. Uses a closure to track the last call's wall-clock time
 * so the orchestrator doesn't have to thread it through.
 */
export function createIdleMicrocompactor(
  gapMs: number,
  aggressiveKeep: number,
  microKeep: number,
): Compactor | null {
  if (gapMs <= 0) return null
  let lastSeenAt = Date.now()
  return {
    tier: 'T0',
    apply(messages) {
      const now = Date.now()
      const idleGap = now - lastSeenAt
      lastSeenAt = now
      const keep = idleGap > gapMs ? aggressiveKeep : microKeep
      if (keep >= microKeep) return null
      const r = microcompact(messages, keep)
      return r.changed
        ? {
            messages: r.messages,
            details: {
              stubbed: r.stubbed,
              idleGapMinutes: Math.round(idleGap / 60_000),
            },
          }
        : null
    },
  }
}

// ────────────────────────────────────────────────────────── dedupe (T2)

export function dedupeToolMessages(
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

export function createDedupeCompactor(): Compactor {
  return {
    tier: 'T2',
    apply(messages) {
      const r = dedupeToolMessages(messages)
      return r.changed ? { messages: r.messages, details: { deduped: r.deduped } } : null
    },
  }
}

// ────────────────────────────────────────────────────────── media (T3 + T3.5)

export function stripAgedMedia(
  messages: BaseMessage[],
  ageTurns: number,
): { changed: boolean; messages: BaseMessage[]; stripped: number } {
  const cutoffIdx = recentRoundCutoff(messages, ageTurns)
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
    const Ctor = (m as unknown as { constructor: new (args: { content: unknown }) => BaseMessage }).constructor
    return new Ctor({ content: next })
  })
  return { changed, messages: out, stripped }
}

export function createAgedMediaCompactor(ageTurns: number): Compactor {
  return {
    tier: 'T3',
    apply(messages) {
      const r = stripAgedMedia(messages, ageTurns)
      return r.changed ? { messages: r.messages, details: { stripped: r.stripped } } : null
    },
  }
}

/**
 * T3.5 — Anthropic enforces a hard cap of ~100 image/document blocks per
 * request. We count media (including blocks nested inside `tool_result.content`
 * arrays) and drop oldest first until we're under the cap.
 */
export function stripExcessMedia(
  messages: BaseMessage[],
  cap: number,
): { changed: boolean; messages: BaseMessage[]; dropped: number } {
  const positions: Array<{ msg: number; block: number }> = []
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!
    if (!Array.isArray(msg.content)) continue
    msg.content.forEach((part, blockIdx) => {
      if (
        part &&
        typeof part === 'object' &&
        'type' in part &&
        ((part as { type: string }).type === 'image' ||
          (part as { type: string }).type === 'document')
      ) {
        positions.push({ msg: i, block: blockIdx })
      }
    })
  }
  if (positions.length <= cap) {
    return { changed: false, messages, dropped: 0 }
  }
  const toDrop = positions.length - cap
  const dropSet = new Set<string>()
  for (let i = 0; i < toDrop; i++) {
    const p = positions[i]!
    dropSet.add(`${p.msg}:${p.block}`)
  }
  const out = messages.map((m, msgIdx) => removeMediaBlocks(m, msgIdx, dropSet))
  return { changed: true, messages: out, dropped: toDrop }
}

function removeMediaBlocks(
  msg: BaseMessage,
  msgIdx: number,
  dropSet: Set<string>,
): BaseMessage {
  if (!Array.isArray(msg.content)) return msg
  let mutated = false
  const next = msg.content.flatMap((part, blockIdx) => {
    if (dropSet.has(`${msgIdx}:${blockIdx}`)) {
      mutated = true
      return [{ type: 'text', text: '[media stripped: 100-block API cap]' }]
    }
    return [part]
  })
  if (!mutated) return msg
  const Ctor = (msg as unknown as { constructor: new (args: { content: unknown }) => BaseMessage }).constructor
  return new Ctor({ content: next })
}

export function createExcessMediaCompactor(cap: number): Compactor {
  return {
    tier: 'T3.5',
    apply(messages) {
      const r = stripExcessMedia(messages, cap)
      return r.changed ? { messages: r.messages, details: { dropped: r.dropped } } : null
    },
  }
}

// ────────────────────────────────────────────────────────── summarize (T4)

export type Summarizer = (messages: BaseMessage[]) => Promise<string>

/**
 * T4 — summarize the oldest chunk when the messages still exceed the
 * trigger after the lossless tiers have run.
 *
 * The trigger check happens inside the compactor so the orchestrator
 * doesn't need to reason about token math. The compactor returns null
 * when no summarization is needed.
 */
export function createSummarizeCompactor(opts: {
  triggerTokens: number
  keepTail: number
  chunkFraction: number
  summarize: Summarizer
  /** Inject a token-counter so this module doesn't import the lib helper. */
  countTokens: (messages: BaseMessage[]) => number
}): Compactor {
  const chunkFraction = clamp01(opts.chunkFraction)
  return {
    tier: 'T4',
    async apply(messages) {
      if (opts.countTokens(messages) < opts.triggerTokens) return null
      if (messages.length <= opts.keepTail + 1) return null
      const r = await summarizeChunk(messages, opts.keepTail, chunkFraction, opts.summarize)
      if (!r.changed) return null
      return {
        messages: r.messages,
        details: { droppedMessages: r.dropped, summaryChars: r.summaryChars },
      }
    },
  }
}

async function summarizeChunk(
  messages: BaseMessage[],
  keepTail: number,
  chunkFraction: number,
  summarize: Summarizer,
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
 * Slide forward from `desired` until we land on a position that doesn't
 * sit between an AIMessage that emitted tool_calls and its corresponding
 * ToolMessage(s). Returns `cap` if we can't find a clean break before then.
 */
export function nextSafeBoundary(
  messages: BaseMessage[],
  desired: number,
  cap: number,
): number {
  let i = desired
  while (i < cap) {
    const prev = messages[i - 1]
    const here = messages[i]
    if (here instanceof ToolMessage) {
      i++
      continue
    }
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

export async function heuristicSummary(messages: BaseMessage[]): Promise<string> {
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

function clamp01(x: number): number {
  if (x <= 0) return 0.001
  if (x > 1) return 1
  return x
}

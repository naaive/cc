/**
 * Multi-tier compaction middleware.
 *
 * The middleware itself is a thin orchestrator: it builds a list of
 * `Compactor`s based on options and runs them in order. Every tier knows
 * how to no-op when its preconditions aren't met, so the orchestrator
 * just walks the list and accumulates events.
 *
 * The tier implementations live in `./compactors.ts`. Tier-pinning
 * semantics, `__pinned` markers, and rough-token estimation live in
 * `../lib/messageUtils.ts` (no langchain runtime there, so they're
 * unit-testable in isolation).
 */

import {
  createMiddleware,
  HumanMessage,
  type AgentMiddleware,
  type BaseMessage,
} from 'langchain'
import { z } from 'zod'
import { roughTokenCount, stringifyContent } from '../lib/messageUtils.js'
import {
  createAgedMediaCompactor,
  createDedupeCompactor,
  createExcessMediaCompactor,
  createIdleMicrocompactor,
  createMicrocompactor,
  createSummarizeCompactor,
  heuristicSummary,
  type CompactionTier,
  type Compactor,
  type Summarizer,
} from './compactors.js'

export { isMessagePinned, pinMessage, roughTokenCount } from '../lib/messageUtils.js'

export interface SummarizationMiddlewareOptions {
  /**
   * T0 (time-gap microcompact). When the wall-clock gap since the last
   * assistant message exceeds this many minutes, the prompt cache is
   * assumed cold and aggressive microcompact runs proactively. Default 30.
   * Pass 0 to disable.
   */
  timeGapMicrocompactMinutes?: number
  /** T1: keep tool_results from at least this many recent rounds intact. */
  microcompactKeepRecent?: number
  /** T2: enable tool-result deduplication. */
  dedupeToolResults?: boolean
  /** T3: strip image/document blocks older than this many rounds. */
  agedMediaStripTurns?: number
  /** T3.5: hard cap on media blocks per request (Anthropic API rejects >100). */
  maxMediaPerRequest?: number
  /** T4: trigger summarization when rough tokens exceed this. */
  triggerTokens?: number
  /** T4: keep at least this many trailing messages verbatim. */
  keepTail?: number
  /** T4: fraction of the compactable region to fold per pass (0 < x ≤ 1). */
  chunkFraction?: number
  /** T4: pluggable summarizer. Returns the summary text. */
  summarize?: Summarizer
  /** Telemetry / debug. */
  onCompact?: (info: CompactionEvent) => void
}

export interface CompactionEvent {
  tier: CompactionTier
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
  const chunkFraction = options.chunkFraction ?? 0.4
  const dedupe = options.dedupeToolResults ?? true
  const summarize = options.summarize ?? heuristicSummary
  const timeGapMs = (options.timeGapMicrocompactMinutes ?? 30) * 60_000
  const maxMedia = options.maxMediaPerRequest ?? 100

  const compactors: Compactor[] = []
  const idle = createIdleMicrocompactor(timeGapMs, 1, microKeep)
  if (idle) compactors.push(idle)
  compactors.push(createMicrocompactor(microKeep))
  if (dedupe) compactors.push(createDedupeCompactor())
  compactors.push(createAgedMediaCompactor(agedMedia))
  compactors.push(createExcessMediaCompactor(maxMedia))
  compactors.push(
    createSummarizeCompactor({
      triggerTokens: trigger,
      keepTail,
      chunkFraction,
      summarize,
      countTokens: roughTokenCount,
    }),
  )

  return createMiddleware({
    name: 'CompactionMiddleware',
    stateSchema,
    beforeModel: async state => {
      const events: CompactionEvent[] = []
      let messages = state.messages
      let tokens = roughTokenCount(messages)

      for (const compactor of compactors) {
        const step = await compactor.apply(messages)
        if (!step) continue
        const after = roughTokenCount(step.messages)
        events.push({
          tier: compactor.tier,
          beforeTokens: tokens,
          afterTokens: after,
          details: step.details,
        })
        messages = step.messages
        tokens = after
      }

      if (events.length === 0) return undefined

      for (const ev of events) options.onCompact?.(ev)

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

// Re-export the tier functions for unit testing. Underscored names signal
// "internal but exposed for tests" — same convention as before.
export {
  microcompact as _microcompact,
  dedupeToolMessages as _dedupeToolMessages,
  stripAgedMedia as _stripAgedMedia,
  nextSafeBoundary as _nextSafeBoundary,
} from './compactors.js'

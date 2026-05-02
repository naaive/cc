/**
 * Summarization middleware — token-budget-driven conversation compaction.
 *
 * cc's "compact" pass kicks in when the conversation approaches the model's
 * context window. We do the same, with a simpler heuristic: count rough
 * tokens (chars/4) across all messages, and when it crosses `triggerTokens`,
 * fold the oldest run of messages into a single SystemMessage that says
 * "earlier in this conversation, the assistant did X, Y, Z" and keep only
 * the trailing window.
 *
 * The summarizer is pluggable — pass `summarize` to use a real LLM, or
 * leave it null to fall back to a deterministic "first/last + bullets"
 * digest. Real cc uses an LLM call here; the heuristic exists so the
 * package can run offline without an API key.
 */

import {
  createMiddleware,
  SystemMessage,
  type AgentMiddleware,
  type BaseMessage,
} from 'langchain'
import { z } from 'zod/v4'

const CHARS_PER_TOKEN = 4

export interface SummarizationMiddlewareOptions {
  /** Trigger compaction when approx token count exceeds this. */
  triggerTokens?: number
  /** Keep at least this many trailing messages verbatim. */
  keepTail?: number
  /** Pluggable summarizer; receives the messages to compact, returns a string. */
  summarize?: (messages: BaseMessage[]) => Promise<string>
  /** Fired once per compaction; useful for telemetry / UI. */
  onCompact?: (info: {
    droppedMessages: number
    beforeTokens: number
    afterTokens: number
  }) => void
}

const stateSchema = z.object({
  // Preserved across the run so resumed sessions don't re-summarize.
  __summaryAppliedAt: z.number().int().nonnegative().optional(),
})

export function createSummarizationMiddleware(
  options: SummarizationMiddlewareOptions = {},
): AgentMiddleware {
  const triggerTokens = options.triggerTokens ?? 80_000
  const keepTail = options.keepTail ?? 12
  const summarize = options.summarize ?? heuristicSummary

  return createMiddleware({
    name: 'SummarizationMiddleware',
    stateSchema,
    beforeModel: async (state: { messages: BaseMessage[] }) => {
      const before = roughTokenCount(state.messages)
      if (before < triggerTokens) return undefined
      if (state.messages.length <= keepTail + 1) return undefined

      const head = state.messages.slice(0, state.messages.length - keepTail)
      const tail = state.messages.slice(state.messages.length - keepTail)
      const summaryText = await summarize(head)
      const summaryMessage = new SystemMessage(
        `[earlier conversation summary]\n${summaryText}`,
      )
      const next = [summaryMessage, ...tail]
      const after = roughTokenCount(next)
      options.onCompact?.({
        droppedMessages: head.length,
        beforeTokens: before,
        afterTokens: after,
      })
      return { messages: next, __summaryAppliedAt: Date.now() }
    },
  })
}

export function roughTokenCount(messages: BaseMessage[]): number {
  let total = 0
  for (const m of messages) {
    const text =
      typeof m.content === 'string'
        ? m.content
        : Array.isArray(m.content)
          ? m.content
              .map(p =>
                typeof p === 'string'
                  ? p
                  : 'text' in p && typeof p.text === 'string'
                    ? p.text
                    : '',
              )
              .join('\n')
          : ''
    total += Math.ceil(text.length / CHARS_PER_TOKEN)
  }
  return total
}

/**
 * Deterministic offline summary: top + bottom snippet + bullet count.
 * Useful for tests; replace with a real LLM call in production via
 * `summarize: async msgs => llm.invoke(...).content`.
 */
async function heuristicSummary(messages: BaseMessage[]): Promise<string> {
  const userTurns = messages.filter(m => m.getType() === 'human').length
  const aiTurns = messages.filter(m => m.getType() === 'ai').length
  const toolCalls = messages.filter(m => m.getType() === 'tool').length
  const firstUser = messages.find(m => m.getType() === 'human')
  const firstUserText = firstUser ? toText(firstUser).slice(0, 200) : ''
  const lastAi = [...messages].reverse().find(m => m.getType() === 'ai')
  const lastAiText = lastAi ? toText(lastAi).slice(0, 200) : ''
  return [
    `Compacted ${messages.length} earlier messages: ${userTurns} user turn(s), ${aiTurns} assistant turn(s), ${toolCalls} tool call(s).`,
    firstUserText && `First user request: ${firstUserText}…`,
    lastAiText && `Most recent assistant reply: ${lastAiText}…`,
  ]
    .filter(Boolean)
    .join('\n')
}

function toText(msg: BaseMessage): string {
  const c = msg.content
  if (typeof c === 'string') return c
  if (Array.isArray(c))
    return c
      .map(p =>
        typeof p === 'string'
          ? p
          : 'text' in p && typeof p.text === 'string'
            ? p.text
            : '',
      )
      .join('\n')
  return ''
}

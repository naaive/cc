/**
 * Pure compaction helpers — extracted so unit tests don't need langchain.
 *
 * `pinMessage` / `isMessagePinned` rely only on the BaseMessage shape
 * (`additional_kwargs` is a structural property, not an instanceof
 * check), so they're safe to test against minimal mock objects.
 */

const PINNED_KEY = '__pinned'
const META_KEY = '__isMeta'

interface MaybePinnableMessage {
  additional_kwargs?: Record<string, unknown>
}

export function pinMessage<T extends MaybePinnableMessage>(msg: T): T {
  ;(msg as { additional_kwargs?: Record<string, unknown> }).additional_kwargs = {
    ...(msg.additional_kwargs ?? {}),
    [PINNED_KEY]: true,
  }
  return msg
}

export function isMessagePinned(msg: MaybePinnableMessage): boolean {
  return Boolean(msg.additional_kwargs?.[PINNED_KEY])
}

/**
 * Mark a message as harness-injected ("meta") rather than real user input.
 *
 * We tag every system-injected user message — plan-mode reminders, denial
 * messages, post-compact summary, hook-block notifications, synthetic
 * tool results — with `isMeta: true`. Real user turns are filtered as
 * `role === 'human' && !isMeta`. Without this discriminator, every
 * "turns since last real user input" counter, every "first user message"
 * heuristic, every compaction-boundary check is wrong.
 */
export function markMeta<T extends MaybePinnableMessage>(msg: T): T {
  ;(msg as { additional_kwargs?: Record<string, unknown> }).additional_kwargs = {
    ...(msg.additional_kwargs ?? {}),
    [META_KEY]: true,
  }
  return msg
}

export function isMetaMessage(msg: MaybePinnableMessage): boolean {
  return Boolean(msg.additional_kwargs?.[META_KEY])
}

interface MaybeRoleMessage extends MaybePinnableMessage {
  getType?: () => string
  _getType?: () => string
}

function roleOf(msg: MaybeRoleMessage): string | undefined {
  if (typeof msg.getType === 'function') return msg.getType()
  if (typeof msg._getType === 'function') return msg._getType()
  return undefined
}

/** Real human turn = role 'human' AND not flagged as meta. */
export function isRealHumanMessage(msg: MaybeRoleMessage): boolean {
  return roleOf(msg) === 'human' && !isMetaMessage(msg)
}

interface MaybeIdMessage extends MaybeRoleMessage {
  id?: string
}

/**
 * Group messages into "API rounds" — one assistant turn plus its
 * tool_results plus the user turn that preceded it.
 *
 * Rationale: the previous "human-turn boundary" heuristic breaks for
 * single-prompt agentic sessions (workflow runners, eval harnesses, sub-agent
 * dispatchers). Those sessions are ONE human input but MANY API round-trips.
 * We group by AIMessage `id` change because each API response gets a unique
 * id from the model; streaming chunks of the same response share the id so
 * they stay in one group.
 *
 * For our purposes, a "round boundary" is any AIMessage whose id differs
 * from the previous AIMessage's id (or any HumanMessage between two
 * AIMessages). The function returns the start indices of each round so
 * compaction can pick boundaries safely.
 */
export function groupByApiRound(messages: readonly MaybeIdMessage[]): number[] {
  const boundaries: number[] = []
  let prevAiId: string | undefined
  let sawAi = false
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!
    const role = roleOf(m)
    if (role === 'human') {
      boundaries.push(i)
      prevAiId = undefined
      sawAi = false
      continue
    }
    if (role === 'ai') {
      // Streaming chunks of the same response share an id; we only push a
      // new boundary when the id changes (or when ids aren't populated,
      // in which case every assistant message gets its own round).
      const sameAsPrev =
        m.id !== undefined && prevAiId !== undefined && m.id === prevAiId
      if (!sawAi || !sameAsPrev) boundaries.push(i)
      prevAiId = m.id
      sawAi = true
      continue
    }
    // tool / system messages stay in the current round.
  }
  if (boundaries.length === 0 && messages.length > 0) boundaries.push(0)
  return boundaries
}

/**
 * Index of the first message in the most recent `n` API rounds.
 * Returns 0 when there are fewer rounds. Replaces the user-turn-based
 * cutoff used by T1 microcompact / T3 aged-media-strip.
 */
export function recentRoundCutoff(
  messages: readonly MaybeIdMessage[],
  n: number,
): number {
  if (n <= 0) return messages.length
  const rounds = groupByApiRound(messages)
  if (rounds.length <= n) return 0
  return rounds[rounds.length - n]!
}

const CHARS_PER_TOKEN = 4

interface MessageWithContent {
  content: unknown
}

/**
 * Approximate token count using chars/4 — same heuristic the harness uses for
 * cheap budget tracking. Walks both string and structured content blocks.
 */
export function roughTokenCount(messages: readonly MessageWithContent[]): number {
  let total = 0
  for (const m of messages) total += Math.ceil(stringifyContent(m).length / CHARS_PER_TOKEN)
  return total
}

export function stringifyContent(msg: MessageWithContent): string {
  const c = msg.content
  if (typeof c === 'string') return c
  if (Array.isArray(c)) {
    return c
      .map(p => {
        if (typeof p === 'string') return p
        if (
          p &&
          typeof p === 'object' &&
          'text' in p &&
          typeof (p as { text: unknown }).text === 'string'
        ) {
          return (p as { text: string }).text
        }
        return ''
      })
      .filter(Boolean)
      .join('\n')
  }
  return ''
}

/**
 * Auto-pin the first message of a given role. Useful for the common
 * "the first user message IS the spec" pattern: pin it so it survives
 * every compaction tier without the host having to call `pinMessage`
 * manually.
 *
 * Returns the messages array unchanged (mutates the matched message in
 * place). Pure — works on any message-shaped object.
 */
export function autoPinFirstByRole<
  M extends MaybePinnableMessage & { getType?: () => string; _getType?: () => string },
>(messages: readonly M[], role: 'human' | 'system' | 'ai' = 'human'): readonly M[] {
  for (const m of messages) {
    const type =
      typeof m.getType === 'function'
        ? m.getType()
        : typeof m._getType === 'function'
          ? m._getType()
          : undefined
    if (type === role) {
      pinMessage(m)
      break
    }
  }
  return messages
}

/** djb2 — small fast non-cryptographic hash. Used for tool-result dedup. */
export function djb2(s: string): string {
  let h = 5381
  for (let i = 0; i < s.length; i++) {
    h = (h * 33) ^ s.charCodeAt(i)
  }
  return (h >>> 0).toString(16)
}

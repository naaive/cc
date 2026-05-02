/**
 * Pure compaction helpers — extracted so unit tests don't need langchain.
 *
 * `pinMessage` / `isMessagePinned` rely only on the BaseMessage shape
 * (`additional_kwargs` is a structural property, not an instanceof
 * check), so they're safe to test against minimal mock objects.
 */

const PINNED_KEY = '__pinned'

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

const CHARS_PER_TOKEN = 4

interface MessageWithContent {
  content: unknown
}

/**
 * Approximate token count using chars/4 — same heuristic cc uses for
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

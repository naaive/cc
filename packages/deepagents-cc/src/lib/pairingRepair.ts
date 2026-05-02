/**
 * Tool-use / tool-result pairing repair.
 *
 * Anthropic rejects (400) any request whose `tool_use` blocks aren't paired
 * 1:1 with `tool_result` blocks in the immediately-following turn. After
 * any compaction (microcompact, dedup, aged-media strip, summarization),
 * eviction, or session resume, orphans creep in:
 *
 *  - an `AIMessage` with tool_calls whose ToolMessages were summarized away,
 *  - a `ToolMessage` whose AIMessage tool_call was dropped,
 *  - duplicate tool_use ids (e.g. when the same compacted assistant message
 *    gets re-added on resume).
 *
 * `repairPairing` walks the message list and:
 *  1. Inserts a synthetic error `ToolMessage` for every tool_use without a
 *     matching tool_result (`[Tool use interrupted]`).
 *  2. Drops `ToolMessage`s whose tool_call_id has no matching tool_use.
 *  3. De-duplicates tool_use / tool_result ids (later wins).
 *
 * Pure (operates on a structural shape) so the middleware can plug
 * langchain's BaseMessage/ToolMessage/AIMessage in without circular deps,
 * and so unit tests can use plain objects.
 *
 * `strict: true` throws on orphans instead of repairing — useful for
 * eval/training pipelines that don't want a synthetic placeholder
 * polluting the conversation.
 */

export const SYNTHETIC_TOOL_RESULT_PLACEHOLDER = '[Tool use interrupted]'

export interface ToolCallRef {
  id: string
  name?: string
}

export interface MessageLike {
  /** "human" | "ai" | "tool" | "system". */
  role: string
  content: unknown
  /** Present on AIMessage. */
  tool_calls?: ToolCallRef[]
  /** Present on ToolMessage. */
  tool_call_id?: string
  name?: string
  /** Present on ToolMessage. */
  status?: 'success' | 'error'
  additional_kwargs?: Record<string, unknown>
}

export interface RepairOptions {
  strict?: boolean
  /** Factory for synthetic ToolMessage placeholders. */
  makeSyntheticToolResult?: (callId: string, toolName: string | undefined) => MessageLike
  /** Telemetry. */
  onRepair?: (info: {
    addedPlaceholders: number
    droppedOrphanResults: number
    deduplicated: number
  }) => void
}

export interface RepairResult {
  messages: MessageLike[]
  changed: boolean
  added: number
  dropped: number
  deduplicated: number
}

const DEFAULT_PLACEHOLDER: RepairOptions['makeSyntheticToolResult'] = (
  callId,
  name,
) => ({
  role: 'tool',
  content: SYNTHETIC_TOOL_RESULT_PLACEHOLDER,
  tool_call_id: callId,
  ...(name !== undefined ? { name } : {}),
  status: 'error' as const,
})

export function repairPairing(
  messages: readonly MessageLike[],
  options: RepairOptions = {},
): RepairResult {
  const make = options.makeSyntheticToolResult ?? DEFAULT_PLACEHOLDER

  // First pass: collect all tool_call_ids declared by AIMessages and
  // all tool_call_ids consumed by ToolMessages. Track duplicates.
  const declaredById = new Map<string, ToolCallRef>()
  const consumedByCallId = new Set<string>()
  const seenToolMessageIds = new Set<string>()
  const dupCallIds = new Set<string>()
  const dupResultIds = new Set<string>()

  for (const m of messages) {
    if (m.role === 'ai' && Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) {
        if (declaredById.has(tc.id)) dupCallIds.add(tc.id)
        else declaredById.set(tc.id, tc)
      }
    }
    if (m.role === 'tool' && typeof m.tool_call_id === 'string') {
      if (seenToolMessageIds.has(m.tool_call_id)) {
        dupResultIds.add(m.tool_call_id)
      } else {
        seenToolMessageIds.add(m.tool_call_id)
      }
      consumedByCallId.add(m.tool_call_id)
    }
  }

  const orphanedToolUses: ToolCallRef[] = []
  for (const [id, tc] of declaredById) {
    if (!consumedByCallId.has(id)) orphanedToolUses.push(tc)
  }

  const orphanedResults: number[] = []
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!
    if (m.role !== 'tool') continue
    const id = m.tool_call_id
    if (typeof id !== 'string') continue
    if (!declaredById.has(id)) orphanedResults.push(i)
  }

  if (
    options.strict &&
    (orphanedToolUses.length > 0 ||
      orphanedResults.length > 0 ||
      dupCallIds.size > 0 ||
      dupResultIds.size > 0)
  ) {
    throw new Error(
      `repairPairing: strict mode — ${orphanedToolUses.length} orphan tool_use, ${orphanedResults.length} orphan tool_result, ${dupCallIds.size + dupResultIds.size} duplicate ids`,
    )
  }

  if (
    orphanedToolUses.length === 0 &&
    orphanedResults.length === 0 &&
    dupCallIds.size === 0 &&
    dupResultIds.size === 0
  ) {
    return { messages: [...messages], changed: false, added: 0, dropped: 0, deduplicated: 0 }
  }

  // Second pass: build the repaired list.
  const dropIdx = new Set(orphanedResults)
  const seenToolUseEmit = new Set<string>()
  const seenToolResultEmit = new Set<string>()
  const out: MessageLike[] = []

  for (let i = 0; i < messages.length; i++) {
    if (dropIdx.has(i)) continue
    const m = messages[i]!
    if (m.role === 'ai' && Array.isArray(m.tool_calls)) {
      const calls = m.tool_calls.filter(tc => {
        if (seenToolUseEmit.has(tc.id)) return false
        seenToolUseEmit.add(tc.id)
        return true
      })
      out.push({ ...m, tool_calls: calls })
      continue
    }
    if (m.role === 'tool' && typeof m.tool_call_id === 'string') {
      if (seenToolResultEmit.has(m.tool_call_id)) continue
      seenToolResultEmit.add(m.tool_call_id)
      out.push(m)
      continue
    }
    out.push(m)
  }

  // Third pass: synthesize tool_result placeholders for orphan tool_uses.
  // Insert each placeholder right after its corresponding AIMessage.
  let added = 0
  for (const orphan of orphanedToolUses) {
    const aiIdx = out.findIndex(
      m => m.role === 'ai' && (m.tool_calls ?? []).some(tc => tc.id === orphan.id),
    )
    if (aiIdx === -1) continue
    let insertAt = aiIdx + 1
    while (
      insertAt < out.length &&
      out[insertAt]!.role === 'tool' &&
      typeof out[insertAt]!.tool_call_id === 'string'
    ) {
      insertAt++
    }
    out.splice(insertAt, 0, make(orphan.id, orphan.name))
    added++
  }

  options.onRepair?.({
    addedPlaceholders: added,
    droppedOrphanResults: orphanedResults.length,
    deduplicated: dupCallIds.size + dupResultIds.size,
  })

  return {
    messages: out,
    changed: true,
    added,
    dropped: orphanedResults.length,
    deduplicated: dupCallIds.size + dupResultIds.size,
  }
}

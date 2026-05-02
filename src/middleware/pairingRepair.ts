/**
 * Pairing-repair middleware.
 *
 * Last stop before the model invocation: scan messages for orphan
 * `tool_use` / `tool_result` blocks (almost always produced by some
 * combination of T1-T4 compaction, eviction, snip, or session resume)
 * and either:
 *
 *  - lenient (default): synthesize an error `ToolMessage` placeholder
 *    for every dangling `tool_use`, drop dangling `tool_result`s, and
 *    de-duplicate ids.
 *  - strict: throw. For training/eval pipelines that don't want
 *    synthetic placeholders polluting the dataset.
 *
 * Without this, every previously-borrowed compaction trick can drop a
 * 400 from the API ("tool_use without matching tool_result"). we have the
 * same guard at `src/utils/messages.ts#ensureToolResultPairing`.
 */

import {
  AIMessage,
  createMiddleware,
  ToolMessage,
  type AgentMiddleware,
  type BaseMessage,
} from 'langchain'
import {
  repairPairing,
  type MessageLike,
  type RepairOptions,
} from '../lib/pairingRepair.js'

export interface PairingRepairOptions {
  /** Throw on orphan/duplicate instead of repairing in place. */
  strict?: boolean
  onRepair?: RepairOptions['onRepair']
}

export function createPairingRepairMiddleware(
  options: PairingRepairOptions = {},
): AgentMiddleware {
  return createMiddleware({
    name: 'PairingRepairMiddleware',
    beforeModel: (state: { messages: BaseMessage[] }) => {
      const adapted: MessageLike[] = state.messages.map(toMessageLike)
      const result = repairPairing(adapted, {
        strict: options.strict,
        ...(options.onRepair !== undefined ? { onRepair: options.onRepair } : {}),
        makeSyntheticToolResult: (id, name) =>
          toMessageLike(
            new ToolMessage({
              content: '[Tool use interrupted]',
              tool_call_id: id,
              ...(name !== undefined ? { name } : {}),
              status: 'error',
            }),
          ),
      })
      if (!result.changed) return undefined
      // Map back to BaseMessage instances. Synthetic results from the
      // make() factory are already real ToolMessage instances tunneled
      // through MessageLike. Original messages we kept by reference.
      const next = result.messages.map(m => fromMessageLike(m, state.messages))
      return { messages: next }
    },
  })
}

function toMessageLike(msg: BaseMessage): MessageLike {
  const role = msg.getType()
  const out: MessageLike = {
    role,
    content: msg.content,
    additional_kwargs: msg.additional_kwargs,
  }
  if (msg instanceof AIMessage) {
    const calls = msg.tool_calls
    if (Array.isArray(calls) && calls.length > 0) {
      out.tool_calls = calls.map(tc => ({ id: tc.id ?? '', name: tc.name }))
    }
  }
  if (msg instanceof ToolMessage) {
    out.tool_call_id = msg.tool_call_id
    if (msg.name) out.name = msg.name
    if (msg.status) out.status = msg.status
  }
  // Stash the original instance so we can restore it without re-construction.
  ;(out as unknown as { __orig: BaseMessage }).__orig = msg
  return out
}

function fromMessageLike(m: MessageLike, _orig: BaseMessage[]): BaseMessage {
  const stashed = (m as unknown as { __orig?: BaseMessage }).__orig
  if (stashed) {
    // For AIMessages whose tool_calls list got de-duped, we need a fresh
    // instance with the trimmed list. For everything else the stash is
    // structurally unchanged.
    if (stashed instanceof AIMessage && Array.isArray(m.tool_calls)) {
      const sameLen =
        Array.isArray(stashed.tool_calls) &&
        stashed.tool_calls.length === m.tool_calls.length
      if (sameLen) return stashed
      return new AIMessage({
        content: stashed.content,
        additional_kwargs: stashed.additional_kwargs,
        tool_calls: m.tool_calls.map(tc => ({
          id: tc.id,
          name: tc.name ?? '',
          args: stashed.tool_calls?.find(t => t.id === tc.id)?.args ?? {},
          type: 'tool_call' as const,
        })),
      })
    }
    return stashed
  }
  // Synthetic placeholder built by `make()` — already a ToolMessage.
  if (m.role === 'tool') {
    return new ToolMessage({
      content: typeof m.content === 'string' ? m.content : '',
      tool_call_id: m.tool_call_id ?? '',
      ...(m.name !== undefined ? { name: m.name } : {}),
      status: m.status ?? 'error',
    })
  }
  throw new Error('pairingRepair: cannot reconstruct message of role ' + m.role)
}

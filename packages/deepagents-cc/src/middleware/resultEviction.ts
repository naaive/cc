/**
 * Result-eviction middleware.
 *
 * Inspects every ToolMessage that flows out of `wrapToolCall` and, when
 * the content is over the eviction threshold and the tool isn't on the
 * "leave alone" list, swaps the content for a short stub and stashes the
 * full payload in the result store. The stub tells the model how to fetch
 * the original via Read (`ccx-store://<id>`).
 *
 * This is one of the highest-leverage context-engineering tricks cc
 * employs: a single 200KB grep result that lives in history forever
 * easily costs 50K tokens per turn after a few rounds. Evicting it
 * keeps the conversation lean while preserving access on demand.
 */

import {
  createMiddleware,
  ToolMessage,
  type AgentMiddleware,
} from 'langchain'
import {
  buildEvictionStub,
  DEFAULT_EVICT_BYTES,
  shouldEvict,
  TOOLS_EXCLUDED_FROM_EVICTION,
  type EvictionPolicy,
  type ResultStore,
} from '../tools/resultStore.js'

export interface ResultEvictionMiddlewareOptions {
  store: ResultStore
  evictBytes?: number
  /** Extra tool names to exclude from eviction (host-defined small-output tools). */
  extraExcluded?: string[]
  /** Hook for telemetry / debug logs. */
  onEvict?: (info: {
    toolName: string
    bytes: number
    storageId: string
  }) => void
}

export function createResultEvictionMiddleware(
  options: ResultEvictionMiddlewareOptions,
): AgentMiddleware {
  const policy: EvictionPolicy = {
    evictBytes: options.evictBytes ?? DEFAULT_EVICT_BYTES,
    excluded: new Set([
      ...TOOLS_EXCLUDED_FROM_EVICTION,
      ...(options.extraExcluded ?? []),
    ]),
  }

  return createMiddleware({
    name: 'ResultEvictionMiddleware',
    wrapToolCall: async (
      request: { toolCall: { name: string } },
      handler: (req: typeof request) => Promise<ToolMessage | unknown>,
    ) => {
      const result = await handler(request)
      if (!(result instanceof ToolMessage)) return result
      const text = typeof result.content === 'string' ? result.content : ''
      if (!shouldEvict(request.toolCall.name, text.length, policy)) return result
      const stored = options.store.put(request.toolCall.name, text)
      options.onEvict?.({
        toolName: request.toolCall.name,
        bytes: text.length,
        storageId: stored.id,
      })
      return new ToolMessage({
        content: buildEvictionStub(stored),
        tool_call_id: result.tool_call_id,
        name: result.name,
        status: result.status,
      })
    },
  })
}

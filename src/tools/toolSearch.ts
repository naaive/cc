/**
 * ToolSearch — the deferred-tool loader.
 *
 * we only expose a small "primary" tool set in the system prompt. Rare or
 * domain-specific tools (MCP servers, sub-agent types, skills) are
 * **deferred**: their names appear in a list, but their JSONSchema
 * definitions are not loaded into the API tool list until the model calls
 * `ToolSearch` to fetch them. This saves a lot of system-prompt tokens.
 *
 * The pure registry lives in `deferredRegistry.ts`; this file is the
 * langchain-side `tool()` wrapper plus the human-readable description.
 */

import { tool } from 'langchain'
import { Command } from '@langchain/langgraph'
import { z } from 'zod'
import { DeferredToolRegistry, type DeferredToolMeta } from './deferredRegistry.js'

export { DeferredToolRegistry, type DeferredToolMeta }

const schema = z.object({
  query: z
    .string()
    .min(1)
    .describe('Query to find deferred tools. Use "select:<tool_name>[,<tool_name>...]" for direct selection, or keywords to search.'),
  max_results: z
    .number()
    .int()
    .positive()
    .max(20)
    .optional()
    .describe('Maximum number of results to return (default: 5).'),
})

const TOOL_SEARCH_DESCRIPTION = `Fetches full schema definitions for deferred tools so they can be called.

Deferred tools appear by name in the system prompt's "Available deferred tools" list. Until fetched, only the name is known — there is no parameter schema, so the tool cannot be invoked.

Result format: each matched tool appears as one <function>{"description": "...", "name": "...", "parameters": {...}}</function> line inside a <functions> block — the same encoding as the tool list at the top of this prompt.

Query forms:
- "select:Read,Edit,Grep" — fetch these exact tools by name
- "notebook jupyter" — keyword search, up to max_results best matches
- "+slack send" — require "slack" in the name, rank by remaining terms`

export function createToolSearchTool(registry: DeferredToolRegistry) {
  return tool(
    (input: z.infer<typeof schema>) => {
      const max = input.max_results ?? 5
      const direct = registry.parseSelect(input.query)
      const matches = direct ?? registry.search(input.query, max)
      if (matches.length === 0) {
        return `(no deferred tool matches for "${input.query}". ${registry.size()} deferred tools available — try a different query.)`
      }
      const block = matches
        .map(meta => {
          const t = meta.tool
          const jsonSchema = (t as unknown as { schema?: unknown }).schema
          let parameters: unknown
          try {
            const z = jsonSchema as { _def?: unknown; toJSONSchema?: () => unknown }
            if (z?.toJSONSchema) parameters = z.toJSONSchema()
            else if (z?._def) parameters = { type: 'object', properties: {} }
            else parameters = jsonSchema ?? { type: 'object', properties: {} }
          } catch {
            parameters = { type: 'object', properties: {} }
          }
          return `<function>${JSON.stringify({
            description: t.description,
            name: t.name,
            parameters,
          })}</function>`
        })
        .join('\n')
      const activated = matches.map(m => m.tool.name)
      return new Command({
        update: { activeTools: activated },
        // Visible result the model uses to decide its next call.
        // langchain's Command supports a `goto`/`update`/`graph` shape; the
        // string content surfaces via the standard ToolMessage path.
      })
    },
    {
      name: 'ToolSearch',
      description: TOOL_SEARCH_DESCRIPTION,
      schema,
    },
  )
}

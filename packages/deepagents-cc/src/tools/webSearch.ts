/**
 * WebSearch tool — thin wrapper around an injectable search backend.
 *
 * cc uses Anthropic's first-party web_search server tool when available, and
 * falls back to a configured provider (Brave/DuckDuckGo/etc). We expose a
 * simple `searchImpl` injection so users can wire whatever fits their setup
 * without baking a specific provider into this package.
 */

import { tool } from 'langchain'
import { z } from 'zod/v4'

export interface WebSearchHit {
  title: string
  url: string
  snippet: string
}

export type WebSearchImpl = (query: string) => Promise<WebSearchHit[]>

const schema = z.object({
  query: z.string().min(1).describe('Search query'),
  max_results: z
    .number()
    .int()
    .positive()
    .max(20)
    .optional()
    .describe('Maximum number of results to return (default 5).'),
})

const description = `Search the web and return ranked results.

Returns a list of {title, url, snippet} entries. Use web_fetch to download a specific result.`

export function createWebSearchTool(searchImpl: WebSearchImpl) {
  return tool(
    async (input: z.infer<typeof schema>) => {
      try {
        const hits = await searchImpl(input.query)
        const limited = hits.slice(0, input.max_results ?? 5)
        if (limited.length === 0) return `(no results for "${input.query}")`
        return limited
          .map((h, i) => `${i + 1}. ${h.title}\n   ${h.url}\n   ${h.snippet}`)
          .join('\n\n')
      } catch (err) {
        return `search failed: ${(err as Error).message}`
      }
    },
    { name: 'web_search', description, schema },
  )
}

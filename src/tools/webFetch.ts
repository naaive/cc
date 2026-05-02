/**
 * WebFetch tool — pull HTML/markdown from a URL and feed it back to the model.
 *
 * The tool follows a "fetch-then-summarize" pattern: download the URL,
 * strip noise (script/style), convert to plain text, truncate to a token
 * budget, and return. We keep the same shape but stay dependency-light:
 * no headless browser, no full HTML parser — a regex-based stripper that
 * covers the common case and explicitly says so when content was truncated.
 */

import { tool } from 'langchain'
import { z } from 'zod/v4'
import { TOOL_DESCRIPTIONS, TOOL_NAMES } from './toolNames.js'
import { htmlToText } from '../lib/html.js'

export { htmlToText }

const DEFAULT_TIMEOUT_MS = 30_000
const MAX_BYTES = 1_500_000 // 1.5MB raw
const MAX_TEXT_CHARS = 60_000 // ~15k tokens

const schema = z.object({
  url: z.string().url().describe('URL to fetch. Must be http(s).'),
  prompt: z
    .string()
    .min(1)
    .describe('Specific question / extraction goal for this page.'),
})

export interface WebFetchOptions {
  /** Override the global fetch (useful for tests / proxies). */
  fetchImpl?: typeof fetch
  timeoutMs?: number
  /** Allow-list of host suffixes. When set, all other hosts are rejected. */
  allowHosts?: string[]
}

export function createWebFetchTool(options: WebFetchOptions = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS

  return tool(
    async (input: z.infer<typeof schema>) => {
      const parsed = new URL(input.url)
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return `Refused: only http(s) URLs are allowed (got ${parsed.protocol}).`
      }
      if (options.allowHosts && options.allowHosts.length > 0) {
        const ok = options.allowHosts.some(suffix =>
          parsed.host === suffix || parsed.host.endsWith(`.${suffix}`),
        )
        if (!ok) {
          return `Refused: host ${parsed.host} is not in the allow list.`
        }
      }

      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      try {
        const res = await fetchImpl(input.url, {
          signal: controller.signal,
          headers: { 'user-agent': 'forge/0.1' },
          redirect: 'follow',
        })
        if (!res.ok) {
          return `HTTP ${res.status} ${res.statusText} fetching ${input.url}`
        }
        const contentType = res.headers.get('content-type') ?? ''
        const reader = res.body?.getReader()
        if (!reader) return `(empty body)`

        const chunks: Uint8Array[] = []
        let total = 0
        while (true) {
          const { value, done } = await reader.read()
          if (done) break
          if (!value) continue
          chunks.push(value)
          total += value.byteLength
          if (total >= MAX_BYTES) break
        }
        const buffer = Buffer.concat(chunks.map(u => Buffer.from(u)))
        let text = buffer.toString('utf8')
        const wasHtml = contentType.includes('html')
        if (wasHtml) text = htmlToText(text)
        const truncated = text.length > MAX_TEXT_CHARS
        if (truncated) text = `${text.slice(0, MAX_TEXT_CHARS)}\n\n[truncated]`
        const promptLine = input.prompt ? `\n\nfollow-up: ${input.prompt}` : ''
        return `URL: ${input.url}\nContent-Type: ${contentType}\n\n${text}${promptLine}`
      } catch (err) {
        return `fetch failed: ${(err as Error).message}`
      } finally {
        clearTimeout(timer)
      }
    },
    {
      name: TOOL_NAMES.WebFetch,
      description: TOOL_DESCRIPTIONS.WebFetch,
      schema,
    },
  )
}


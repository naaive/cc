/**
 * Default summarizer for oversized sub-agent results.
 *
 * we collapse huge sub-agent reports into "head + tail with marker" before
 * injecting them back into the parent — so a 50KB sub-agent dump doesn't
 * eat 50KB of parent context. This is the cheap zero-LLM version. Hosts
 * that want a real LLM summary can plug their own via
 * `createAgentTool({ summarizeLargeResult })`.
 */
export function defaultLargeResultSummary(text: string): string {
  const HEAD = 1500
  const TAIL = 1500
  if (text.length <= HEAD + TAIL) return text
  const head = text.slice(0, HEAD)
  const tail = text.slice(-TAIL)
  return `${head}\n\n[... ${text.length - HEAD - TAIL} chars elided by sub-agent auto-summarize ...]\n\n${tail}`
}

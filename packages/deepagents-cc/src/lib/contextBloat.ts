/**
 * Context-bloat analyzer + suggestion ladder.
 *
 * Walks the live message list, attributes rough tokens to each tool by
 * summing the lengths of its `tool_result` content, and emits typed
 * suggestions when one tool eats > a configurable share of the budget.
 *
 * Returns at most a handful of suggestions, sorted by expected savings
 * (highest first). Pure (no langchain), so the host can wire it into a
 * `<system-reminder>` factory or a UI dashboard.
 */

const CHARS_PER_TOKEN = 4

export interface BloatMessage {
  role: string
  content: unknown
  tool_call_id?: string
  /** AIMessage tool_calls — used to attribute tool_result back to its tool name. */
  tool_calls?: Array<{ id: string; name?: string; args?: unknown }>
}

export interface BloatSuggestion {
  /** Severity tier — `warning` if a tool exceeds `warnPctOfTotal`. */
  severity: 'info' | 'warning'
  toolName: string
  pctOfTotal: number
  estimatedTokens: number
  message: string
}

export interface BloatAnalysis {
  totalTokens: number
  byTool: Map<string, { tokens: number; calls: number }>
  duplicateReadPaths: string[]
  suggestions: BloatSuggestion[]
}

export interface AnalyzeBloatOptions {
  /** Trigger info-level suggestion at this fraction of total. Default 0.10. */
  infoPctOfTotal?: number
  /** Trigger warning-level suggestion at this fraction. Default 0.20. */
  warnPctOfTotal?: number
  /** Cap on suggestions returned. Default 5. */
  maxSuggestions?: number
}

export function analyzeContextBloat(
  messages: readonly BloatMessage[],
  options: AnalyzeBloatOptions = {},
): BloatAnalysis {
  const infoPct = options.infoPctOfTotal ?? 0.1
  const warnPct = options.warnPctOfTotal ?? 0.2
  const maxSuggestions = options.maxSuggestions ?? 5

  // Build tool_call_id → tool_name map by walking AIMessages first.
  const callToTool = new Map<string, string>()
  for (const m of messages) {
    if (m.role === 'ai' && Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) {
        if (tc.id && tc.name) callToTool.set(tc.id, tc.name)
      }
    }
  }

  const byTool = new Map<string, { tokens: number; calls: number }>()
  let totalTokens = 0
  const readPaths = new Map<string, number>()

  for (const m of messages) {
    const len = approxTokens(m.content)
    totalTokens += len
    if (m.role !== 'tool' || !m.tool_call_id) continue
    const tool = callToTool.get(m.tool_call_id) ?? 'unknown'
    const cur = byTool.get(tool) ?? { tokens: 0, calls: 0 }
    cur.tokens += len
    cur.calls += 1
    byTool.set(tool, cur)
    if (tool === 'Read') {
      // Pull the file_path from the AIMessage's tool_call args.
      const ai = messages.find(
        x => x.role === 'ai' && (x.tool_calls ?? []).some(t => t.id === m.tool_call_id),
      )
      const call = ai?.tool_calls?.find(t => t.id === m.tool_call_id)
      const args = call?.args as { file_path?: string } | undefined
      if (args?.file_path) {
        readPaths.set(args.file_path, (readPaths.get(args.file_path) ?? 0) + 1)
      }
    }
  }

  const duplicateReadPaths = [...readPaths.entries()]
    .filter(([, n]) => n > 1)
    .map(([p]) => p)

  const suggestions: BloatSuggestion[] = []
  for (const [tool, info] of byTool) {
    if (totalTokens === 0) continue
    const pct = info.tokens / totalTokens
    if (pct >= warnPct) {
      suggestions.push({
        severity: 'warning',
        toolName: tool,
        pctOfTotal: pct,
        estimatedTokens: info.tokens,
        message: hintFor(tool, pct),
      })
    } else if (pct >= infoPct) {
      suggestions.push({
        severity: 'info',
        toolName: tool,
        pctOfTotal: pct,
        estimatedTokens: info.tokens,
        message: hintFor(tool, pct),
      })
    }
  }
  if (duplicateReadPaths.length > 0) {
    suggestions.push({
      severity: 'info',
      toolName: 'Read',
      pctOfTotal: 0,
      estimatedTokens: 0,
      message: `Re-read of ${duplicateReadPaths.length} file(s) detected: ${duplicateReadPaths
        .slice(0, 3)
        .join(', ')}${duplicateReadPaths.length > 3 ? ', …' : ''}. Reference the prior Read tool_result instead.`,
    })
  }

  // Warnings before info, then larger savings first.
  suggestions.sort((a, b) => {
    if (a.severity !== b.severity) return a.severity === 'warning' ? -1 : 1
    return b.estimatedTokens - a.estimatedTokens
  })

  return {
    totalTokens,
    byTool,
    duplicateReadPaths,
    suggestions: suggestions.slice(0, maxSuggestions),
  }
}

function hintFor(tool: string, pct: number): string {
  const pctText = `${Math.round(pct * 100)}%`
  switch (tool) {
    case 'Bash':
    case 'PowerShell':
      return `${tool} output is taking ${pctText} of context. Pipe through head/tail/grep, or write to a file and use Read with offset/limit.`
    case 'Read':
      return `Read output is ${pctText} of context. Use offset/limit to page large files instead of reading whole files.`
    case 'Grep':
      return `Grep is ${pctText} of context. Narrow with type=, glob=, or head_limit, or switch output_mode to "files_with_matches"/"count".`
    case 'Glob':
      return `Glob results are ${pctText} of context. Use a more specific pattern or pass head_limit.`
    case 'WebFetch':
      return `WebFetch payloads are ${pctText} of context. Pass a more focused prompt to extract only what you need.`
    case 'Agent':
      return `Sub-agent results are ${pctText} of context. The Agent tool already auto-summarizes oversize replies — check for very large per-call outputs.`
    default:
      return `${tool} output is taking ${pctText} of context. Consider returning less data per call.`
  }
}

function approxTokens(content: unknown): number {
  if (typeof content === 'string') return Math.ceil(content.length / CHARS_PER_TOKEN)
  if (Array.isArray(content)) {
    let total = 0
    for (const part of content) {
      if (typeof part === 'string') total += Math.ceil(part.length / CHARS_PER_TOKEN)
      else if (
        part &&
        typeof part === 'object' &&
        'text' in part &&
        typeof (part as { text: unknown }).text === 'string'
      ) {
        total += Math.ceil((part as { text: string }).text.length / CHARS_PER_TOKEN)
      }
    }
    return total
  }
  return 0
}

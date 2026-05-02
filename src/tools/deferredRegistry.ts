/**
 * Pure deferred-tool registry. Lives separately from `toolSearch.ts` (which
 * imports langchain to expose `tool()`) so the registry semantics — search,
 * select, system-prompt-block formatting — can be unit-tested without the
 * langchain runtime.
 */

import type { StructuredTool } from 'langchain'

export interface DeferredToolMeta {
  /** The tool itself, callable via langchain. */
  tool: StructuredTool
  /** Optional search hints (synonyms, related keywords). */
  hints?: string[]
}

export class DeferredToolRegistry {
  private readonly tools = new Map<string, DeferredToolMeta>()

  register(meta: DeferredToolMeta): void {
    this.tools.set(meta.tool.name, meta)
  }

  registerAll(tools: StructuredTool[]): void {
    for (const t of tools) this.register({ tool: t })
  }

  list(): DeferredToolMeta[] {
    return [...this.tools.values()]
  }

  size(): number {
    return this.tools.size
  }

  get(name: string): DeferredToolMeta | undefined {
    return this.tools.get(name)
  }

  /**
   * Snapshot the full deferred-tool list as a single string for the system
   * prompt. Each entry is just the name (experience showed that adding hints
   * didn't move the needle).
   */
  toSystemPromptBlock(): string | null {
    if (this.tools.size === 0) return null
    const names = [...this.tools.keys()].sort()
    return `Some tools are deferred and not listed above. When a deferred tool is surfaced later in the conversation, its full schema appears as a <function>{...}</function> definition in a <functions> block — that is the encoding used by the tool list at the top of this prompt. Once a tool's schema appears that way, it is callable exactly like any tool defined at the top.

Available deferred tools (call ToolSearch to load their schemas):
${names.map(n => `  - ${n}`).join('\n')}`
  }

  /** Substring + token-overlap rank. Returns top-N. */
  search(query: string, max: number): DeferredToolMeta[] {
    const q = query.toLowerCase().trim()
    const scored = [...this.tools.values()]
      .map(meta => {
        const haystack = [
          meta.tool.name,
          meta.tool.description,
          ...(meta.hints ?? []),
        ]
          .join(' ')
          .toLowerCase()
        const tokens = q.split(/\s+/).filter(Boolean)
        let score = 0
        for (const tok of tokens) {
          if (meta.tool.name.toLowerCase().includes(tok)) score += 10
          else if (haystack.includes(tok)) score += 1
        }
        return { meta, score }
      })
      .filter(s => s.score > 0)
      .sort((a, b) => b.score - a.score)
    return scored.slice(0, max).map(s => s.meta)
  }

  parseSelect(query: string): DeferredToolMeta[] | null {
    if (!query.startsWith('select:')) return null
    const names = query.slice(7).split(',').map(s => s.trim()).filter(Boolean)
    return names
      .map(n => this.tools.get(n))
      .filter((t): t is DeferredToolMeta => Boolean(t))
  }
}

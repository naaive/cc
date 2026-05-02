/**
 * MCP integration — thin ergonomic wrapper over `@langchain/mcp-adapters`.
 *
 * The official langchain adapter (`@langchain/mcp-adapters`) already
 * handles stdio + SSE transports, the JSON-RPC handshake, tool wrapping,
 * lifecycle, and auth. We add three things on top:
 *
 *   1. A typed `setupMcpServers` helper that returns the client AND the
 *      langchain tools in one shot, ready to feed `createClaudeCodeAgent`
 *      via its `deferredTools` parameter.
 *   2. A `mcpToolName(server, tool)` namespace helper matching cc's
 *      `mcp__<server>__<tool>` convention. (`MultiServerMCPClient` already
 *      namespaces by default; we re-export the helper for parity.)
 *   3. A teardown shortcut returned alongside the client.
 *
 * Why deferred? An MCP server can expose dozens of tools. Listing them all
 * in the API tool definitions wastes tokens — feeding them through the
 * deferred registry means the model only loads the schemas it actually
 * needs via `ToolSearch`.
 */

import type { StructuredTool } from 'langchain'

/**
 * Re-exported for type-only consumers. The runtime class lives in
 * `@langchain/mcp-adapters`; we keep the package as a peer dep so it
 * doesn't get bundled when MCP is unused.
 */
export type MultiServerMCPClient = unknown

export interface McpServerConfig {
  /** Transport: "stdio" (default) or "sse". */
  transport?: 'stdio' | 'sse'
  /** stdio: executable. */
  command?: string
  /** stdio: args. */
  args?: string[]
  /** stdio: env. */
  env?: Record<string, string>
  /** sse: url. */
  url?: string
}

export interface SetupMcpResult {
  client: MultiServerMCPClient
  tools: StructuredTool[]
  stop(): Promise<void>
}

/**
 * Build a multi-server MCP client and return its tools as deferred-ready
 * `StructuredTool[]`. Pass them via `createClaudeCodeAgent({ deferredTools })`.
 *
 * Example:
 * ```ts
 * const mcp = await setupMcpServers({
 *   slack: { command: "npx", args: ["-y", "@modelcontextprotocol/server-slack"] },
 *   github: { command: "npx", args: ["-y", "@modelcontextprotocol/server-github"] },
 * })
 * const { agent } = createClaudeCodeAgent({ deferredTools: mcp.tools })
 * try { await agent.invoke({ messages }) } finally { await mcp.stop() }
 * ```
 */
export async function setupMcpServers(
  servers: Record<string, McpServerConfig>,
): Promise<SetupMcpResult> {
  // Lazy import so the package is optional. Hosts that don't use MCP
  // never pay the import cost or need the dependency installed.
  const mod = (await import('@langchain/mcp-adapters' as string)) as {
    MultiServerMCPClient: new (cfg: { mcpServers: Record<string, McpServerConfig> }) => {
      getTools(): Promise<StructuredTool[]>
      close(): Promise<void>
    }
  }
  const client = new mod.MultiServerMCPClient({ mcpServers: servers })
  const tools = await client.getTools()
  return {
    client,
    tools,
    async stop() {
      await client.close()
    },
  }
}

/** cc-style namespace: `mcp__<server>__<tool>`. */
export function mcpToolName(server: string, tool: string): string {
  return `mcp__${server}__${tool}`
}

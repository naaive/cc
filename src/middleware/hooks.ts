/**
 * Hooks middleware — PreToolUse / PostToolUse / UserPromptSubmit /
 * SessionStart event surface.
 *
 * The harness runs configured shell commands at well-known points so
 * users can audit, redact, or block tool calls. We keep the same event
 * names but support both shell-command hooks (executed via /bin/sh) and
 * inline JS function hooks. The result of a hook can:
 *   - return `{ block: true, message }` to deny the operation
 *   - return `{ replaceArgs }` to rewrite a tool call's input
 *   - return `{ append }` to append text to the user prompt
 *   - return nothing to do nothing
 */

import { spawnSync } from 'node:child_process'
import { markMeta } from '../lib/messageUtils.js'
import {
  createMiddleware,
  HumanMessage,
  ToolMessage,
  type AgentMiddleware,
  type BaseMessage,
} from 'langchain'

export type HookEvent =
  | 'SessionStart'
  | 'UserPromptSubmit'
  | 'PreToolUse'
  | 'PostToolUse'
  | 'Stop'

export interface HookPayload {
  event: HookEvent
  cwd: string
  /** Tool name (PreToolUse / PostToolUse only). */
  toolName?: string
  /** Tool input (PreToolUse only). */
  toolInput?: unknown
  /** Tool result content (PostToolUse only). */
  toolOutput?: string
  /** User prompt text (UserPromptSubmit only). */
  prompt?: string
}

export interface HookResult {
  block?: boolean
  message?: string
  replaceArgs?: unknown
  append?: string
}

export type InlineHook = (payload: HookPayload) => HookResult | Promise<HookResult> | void

export interface ShellHook {
  /** Shell command. The payload is piped on stdin as JSON. */
  command: string
  /** Working directory; defaults to process.cwd(). */
  cwd?: string
  /** Timeout in ms; defaults to 5000. */
  timeoutMs?: number
}

export type Hook = InlineHook | ShellHook

export interface HookConfig {
  SessionStart?: Hook[]
  UserPromptSubmit?: Hook[]
  PreToolUse?: Hook[]
  PostToolUse?: Hook[]
  Stop?: Hook[]
}

export interface HooksMiddlewareOptions {
  hooks: HookConfig
  cwd?: string
}

export function createHooksMiddleware(
  options: HooksMiddlewareOptions,
): AgentMiddleware {
  const cwd = options.cwd ?? process.cwd()
  const hooks = options.hooks

  return createMiddleware({
    name: 'HooksMiddleware',
    beforeAgent: async (state: { messages: BaseMessage[]; __sessionStarted?: boolean }) => {
      if (state.__sessionStarted) return undefined
      await runHooks(hooks.SessionStart ?? [], { event: 'SessionStart', cwd })
      return { __sessionStarted: true }
    },
    beforeModel: async (state: { messages: BaseMessage[] }) => {
      const last = lastHuman(state.messages)
      if (!last) return undefined
      const text = stringContent(last)
      const results = await runHooks(hooks.UserPromptSubmit ?? [], {
        event: 'UserPromptSubmit',
        cwd,
        prompt: text,
      })
      const blocked = results.find(r => r.block)
      if (blocked) {
        // Replace the user message with an explanation so the model knows
        // the prompt was rejected — this lets it apologize / stop cleanly.
        const messages = [...state.messages]
        const blockMsg = new HumanMessage(
          `[blocked by UserPromptSubmit hook] ${blocked.message ?? 'rejected'}`,
        )
        markMeta(blockMsg)
        messages[messages.lastIndexOf(last)] = blockMsg
        return { messages }
      }
      const appended = results
        .map(r => r.append)
        .filter((a): a is string => typeof a === 'string' && a.length > 0)
      if (appended.length > 0) {
        const messages = [...state.messages]
        const newText = `${text}\n\n${appended.join('\n\n')}`
        messages[messages.lastIndexOf(last)] = new HumanMessage(newText)
        return { messages }
      }
      return undefined
    },
    wrapToolCall: async (request, handler) => {
      const pre = await runHooks(hooks.PreToolUse ?? [], {
        event: 'PreToolUse',
        cwd,
        toolName: request.toolCall.name,
        toolInput: request.toolCall.args,
      })
      const blockedPre = pre.find(r => r.block)
      if (blockedPre) {
        return new ToolMessage({
          content: blockedPre.message ?? `Blocked by PreToolUse hook.`,
          tool_call_id: request.toolCall.id ?? '',
          name: request.toolCall.name,
          status: 'error',
        })
      }
      const replaced = pre.find(r => r.replaceArgs !== undefined)
      const next =
        replaced != null
          ? ({
              ...request,
              toolCall: { ...request.toolCall, args: replaced.replaceArgs },
            } as typeof request)
          : request

      const result = await handler(next)

      const post = await runHooks(hooks.PostToolUse ?? [], {
        event: 'PostToolUse',
        cwd,
        toolName: request.toolCall.name,
        toolOutput:
          result instanceof ToolMessage ? stringContent(result) : undefined,
      })
      const blockedPost = post.find(r => r.block)
      if (blockedPost) {
        return new ToolMessage({
          content: `${stringContent(result as BaseMessage)}\n\n[PostToolUse hook: ${blockedPost.message ?? 'flagged'}]`,
          tool_call_id: request.toolCall.id ?? '',
          name: request.toolCall.name,
          status: 'error',
        })
      }
      return result
    },
    afterAgent: async () => {
      await runHooks(hooks.Stop ?? [], { event: 'Stop', cwd })
      return undefined
    },
  })
}

async function runHooks(
  hooks: Hook[],
  payload: HookPayload,
): Promise<HookResult[]> {
  const out: HookResult[] = []
  for (const hook of hooks) {
    const r = await runHook(hook, payload)
    if (r) out.push(r)
  }
  return out
}

async function runHook(
  hook: Hook,
  payload: HookPayload,
): Promise<HookResult | undefined> {
  if (typeof hook === 'function') {
    const r = await hook(payload)
    return r ?? undefined
  }
  // Shell hook
  try {
    const res = spawnSync('/bin/sh', ['-c', hook.command], {
      cwd: hook.cwd ?? payload.cwd,
      timeout: hook.timeoutMs ?? 5000,
      input: JSON.stringify(payload),
      encoding: 'utf8',
    })
    if (res.status !== 0) {
      // Non-zero exit means "block".
      return {
        block: true,
        message: (res.stderr || res.stdout || '').trim() || `hook exited ${res.status}`,
      }
    }
    const stdout = res.stdout?.trim() ?? ''
    if (!stdout) return undefined
    // Try to parse stdout as JSON HookResult; otherwise treat as append text.
    try {
      const parsed = JSON.parse(stdout)
      if (parsed && typeof parsed === 'object') return parsed as HookResult
    } catch {
      return { append: stdout }
    }
    return undefined
  } catch (err) {
    return { block: true, message: (err as Error).message }
  }
}

function lastHuman(messages: BaseMessage[]): BaseMessage | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.getType() === 'human') return messages[i]
  }
  return undefined
}

function stringContent(msg: BaseMessage): string {
  const c = msg.content
  if (typeof c === 'string') return c
  if (Array.isArray(c))
    return c
      .map(part =>
        typeof part === 'string'
          ? part
          : 'text' in part && typeof part.text === 'string'
            ? part.text
            : '',
      )
      .join('\n')
  return ''
}

/**
 * Agent tool — cc-aligned name (cc calls this `Agent`, not `task`).
 *
 * Dispatches a self-contained sub-task to a specialized sub-agent with its
 * own context window. The model picks `subagent_type` from the configured
 * list. Each invocation is stateless: the sub-agent doesn't see the
 * parent conversation; the prompt must contain everything it needs.
 *
 * Sub-agents share the parent's FileStateCache and PersistentShell so disk
 * state stays coherent (read-before-edit guard works across the boundary).
 */

import { tool, HumanMessage } from 'langchain'
import { z } from 'zod/v4'
import { TOOL_DESCRIPTIONS, TOOL_NAMES, type ToolName } from './ccToolNames.js'

export interface SubAgent {
  name: string
  description: string
  systemPrompt?: string
  /** Tool names this sub-agent can use. When omitted, inherits parent tools. */
  toolWhitelist?: ToolName[]
  /** Override the model. */
  model?: string
}

export type SubAgentFactory = (sub: SubAgent) => {
  invoke: (input: { messages: Array<HumanMessage> | unknown[] }) => Promise<{
    messages: Array<{ content: unknown }>
  }>
}

export interface AgentToolOptions {
  subagents: SubAgent[]
  factory: SubAgentFactory
}

export function createAgentTool(options: AgentToolOptions) {
  const subagents = options.subagents
  const names = subagents.map(s => s.name)
  if (new Set(names).size !== names.length) {
    throw new Error(`duplicate sub-agent name(s): ${names.join(', ')}`)
  }

  const schema = z.object({
    subagent_type: z
      .enum(names.length > 0 ? (names as [string, ...string[]]) : ['general-purpose'])
      .describe('Which sub-agent type to dispatch to.'),
    description: z.string().min(1).describe('Short (3-5 word) description of the sub-task.'),
    prompt: z
      .string()
      .min(1)
      .describe('Self-contained prompt for the sub-agent. The sub-agent does not see this conversation.'),
  })

  const description = buildAgentDescription(subagents)

  return tool(
    async (input: z.infer<typeof schema>) => {
      const sub = subagents.find(s => s.name === input.subagent_type)
      if (!sub) return `unknown subagent_type: ${input.subagent_type}`
      const runnable = options.factory(sub)
      const result = await runnable.invoke({
        messages: [new HumanMessage(input.prompt)],
      })
      const last = result.messages?.at(-1)
      return messageToText(last) || '(no reply)'
    },
    {
      name: TOOL_NAMES.Agent,
      description,
      schema,
    },
  )
}

function buildAgentDescription(subagents: SubAgent[]): string {
  const list = subagents.map(s => `  - ${s.name}: ${s.description}`).join('\n')
  return `${TOOL_DESCRIPTIONS.Agent}\n\nAvailable subagent_type values:\n${list || '  (none configured)'}`
}

function messageToText(msg: unknown): string {
  if (!msg || typeof msg !== 'object') return ''
  const content = (msg as { content?: unknown }).content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map(part => {
        if (typeof part === 'string') return part
        if (
          part &&
          typeof part === 'object' &&
          'text' in part &&
          typeof (part as { text: unknown }).text === 'string'
        ) {
          return (part as { text: string }).text
        }
        return ''
      })
      .filter(Boolean)
      .join('')
  }
  return ''
}

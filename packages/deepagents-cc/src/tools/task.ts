/**
 * task — dispatch work to a sub-agent with an isolated context window.
 *
 * The model invokes `task` with a `subagent_type` plus a `prompt`. We look
 * up the matching SubAgent definition, build a fresh agent (using the
 * provided factory), invoke it with the prompt, and return only its final
 * text reply — the sub-agent's tool calls / intermediate messages stay
 * isolated from the parent's context.
 *
 * cc's behavior:
 *  - `general-purpose` sub-agent is always available (full tool access).
 *  - Custom sub-agents have their own tool whitelist.
 *  - The description shown to the model is composed from each sub-agent's
 *    description so it can pick the right one.
 */

import { tool, HumanMessage } from 'langchain'
import { z } from 'zod/v4'

export interface SubAgent {
  name: string
  description: string
  systemPrompt?: string
  /** Tool names this sub-agent can use. When omitted, inherits parent tools. */
  toolWhitelist?: string[]
  /** Override the model. */
  model?: string
}

/**
 * Factory invoked once per `task` call. Receives the chosen sub-agent
 * spec; returns a runnable with `.invoke({ messages })`.
 *
 * This indirection lets the host wire things like checkpointers, custom
 * middleware, or model overrides per sub-agent without baking them into
 * this tool.
 */
export type SubAgentFactory = (sub: SubAgent) => {
  invoke: (input: { messages: Array<HumanMessage> | unknown[] }) => Promise<{
    messages: Array<{ content: unknown }>
  }>
}

export interface TaskToolOptions {
  subagents: SubAgent[]
  factory: SubAgentFactory
}

export function createTaskTool(options: TaskToolOptions) {
  const subagents = options.subagents
  const names = subagents.map(s => s.name)
  if (new Set(names).size !== names.length) {
    throw new Error(`duplicate sub-agent name(s): ${names.join(', ')}`)
  }

  const schema = z.object({
    subagent_type: z
      .enum(names.length > 0 ? (names as [string, ...string[]]) : ['general-purpose'])
      .describe('Which sub-agent to dispatch to.'),
    description: z
      .string()
      .min(1)
      .describe('Short (3-5 word) description of the sub-task.'),
    prompt: z
      .string()
      .min(1)
      .describe(
        'Self-contained prompt for the sub-agent. Include all context — the sub-agent does not see this conversation.',
      ),
  })

  const description = buildDescription(subagents)

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
    { name: 'task', description, schema },
  )
}

function buildDescription(subagents: SubAgent[]): string {
  const list = subagents
    .map(s => `  - ${s.name}: ${s.description}`)
    .join('\n')
  return `Dispatch a self-contained sub-task to a specialized agent with its own context window.

Available subagent_type values:
${list || '  (none configured)'}

Rules:
 - Each call is stateless. The sub-agent does not see this conversation. Pass everything it needs in \`prompt\`.
 - The sub-agent returns ONE final message. Show that message to the user yourself if relevant.
 - Launch independent sub-tasks in parallel (multiple tool_use blocks in one assistant turn).
 - Use the general-purpose sub-agent for open-ended research, code search, or multi-step exploration.`
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

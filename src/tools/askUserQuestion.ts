/**
 * AskUserQuestion tool — controlled clarifying questions.
 *
 * We use a structured ask-user-question tool so the UI can render
 * radio/checkbox selectors instead of free-form replies. We keep the same
 * shape (header + options + multiSelect flag) and ship a CLI-friendly
 * default handler that prints to stdout / reads from stdin. Custom UIs
 * (Ink, web UI) override `respond`.
 */

import { tool } from 'langchain'
import { z } from 'zod/v4'
import { createInterface } from 'node:readline'
import { TOOL_DESCRIPTIONS, TOOL_NAMES } from './toolNames.js'

export interface QuestionOption {
  label: string
  description?: string
}

export interface AskUserQuestionInput {
  questions: Array<{
    header: string
    question: string
    options: QuestionOption[]
    multiSelect: boolean
  }>
}

export type AskUserQuestionResponder = (
  input: AskUserQuestionInput,
) => Promise<string[]>

const optionSchema = z.object({
  label: z.string().min(1),
  description: z.string().optional(),
})

const schema = z.object({
  questions: z
    .array(
      z.object({
        header: z.string().min(1).describe('Short heading shown above the choices.'),
        question: z.string().min(1).describe('The question itself.'),
        options: z.array(optionSchema).min(2).describe('Predefined choices.'),
        multiSelect: z.boolean().describe('Allow multiple selections.'),
      }),
    )
    .min(1)
    .max(5),
})

export function createAskUserQuestionTool(
  respond: AskUserQuestionResponder = readlineResponder,
) {
  return tool(
    async (input: z.infer<typeof schema>) => {
      const answers = await respond(input)
      return answers
        .map((a, i) => `Q${i + 1}: ${input.questions[i]?.question ?? ''}\nA${i + 1}: ${a}`)
        .join('\n\n')
    },
    {
      name: TOOL_NAMES.AskUserQuestion,
      description: TOOL_DESCRIPTIONS.AskUserQuestion,
      schema,
    },
  )
}

async function readlineResponder(
  input: AskUserQuestionInput,
): Promise<string[]> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const ask = (prompt: string) =>
    new Promise<string>(resolve => rl.question(prompt, resolve))
  const answers: string[] = []
  for (let i = 0; i < input.questions.length; i++) {
    const q = input.questions[i]!
    process.stdout.write(`\n[${q.header}] ${q.question}\n`)
    q.options.forEach((o, idx) => {
      process.stdout.write(
        `  ${idx + 1}) ${o.label}${o.description ? ` — ${o.description}` : ''}\n`,
      )
    })
    const hint = q.multiSelect
      ? 'pick one or more, comma-separated: '
      : 'pick one: '
    const reply = (await ask(hint)).trim()
    const indices = reply
      .split(',')
      .map(s => Number(s.trim()))
      .filter(n => Number.isInteger(n) && n >= 1 && n <= q.options.length)
    const labels = indices.map(idx => q.options[idx - 1]!.label).join(', ')
    answers.push(labels || reply)
  }
  rl.close()
  return answers
}

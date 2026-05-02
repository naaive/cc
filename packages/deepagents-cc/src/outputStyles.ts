/**
 * Output styles — cc's preset response personalities.
 *
 * cc lets the user pick an output style that customizes how the model
 * frames its replies without changing the tool surface or the agent
 * loop. Built-in presets:
 *
 *   - `concise` (default): short, direct, no preamble.
 *   - `explanatory`: same actions, but with one-paragraph explanations
 *     of WHAT changed and WHY before/after each tool batch.
 *   - `learning`: explanatory + leaves comments and TODOs for the user
 *     to fill in, surfaces hints rather than complete solutions.
 *
 * Hosts can register custom styles. The selected style's prompt is
 * appended to the system prompt under a `# Output Style: <name>` header
 * so the model treats it as authoritative behavior guidance.
 */

export interface OutputStyle {
  name: string
  prompt: string
}

export const OUTPUT_STYLES: Record<string, OutputStyle> = {
  concise: {
    name: 'concise',
    prompt: `Respond as briefly as the question allows. No preamble, no recap of what you just did unless the user asks. End-of-turn summary is one or two sentences max.`,
  },
  explanatory: {
    name: 'explanatory',
    prompt: `Before each meaningful tool batch, write one paragraph (≤4 sentences) explaining WHAT you're about to do and WHY. After the batch, write one paragraph summarizing the outcome and any surprises. Keep code commentary out — explanation lives in your reply, not in the file.`,
  },
  learning: {
    name: 'learning',
    prompt: `Treat every interaction as a learning opportunity for the user. Explain decisions step-by-step. When you'd otherwise write a complete solution, leave one or two strategic gaps as // TODO comments with a hint, so the user can fill them in. Surface alternatives and tradeoffs the user might not have considered.`,
  },
}

export function getOutputStyle(
  name: string | undefined,
  custom?: Record<string, OutputStyle>,
): OutputStyle | null {
  if (!name) return null
  return custom?.[name] ?? OUTPUT_STYLES[name] ?? null
}

export function formatOutputStyleSection(style: OutputStyle): string {
  return `# Output Style: ${style.name}\n${style.prompt}`
}

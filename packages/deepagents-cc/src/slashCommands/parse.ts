/**
 * Slash command parser — same shape as cc's REPL.
 *
 * Input: `/init this is a description` → { name: "init", args: "this is a description" }
 * A leading slash is required; everything after the first whitespace is args.
 */

export interface ParsedSlashCommand {
  name: string
  args: string
}

export function parseSlashCommand(input: string): ParsedSlashCommand | null {
  const trimmed = input.trimStart()
  if (!trimmed.startsWith('/')) return null
  // Avoid eating "/path/to/something" — slashes inside a non-leading word are
  // not commands.
  const m = trimmed.match(/^\/([a-zA-Z][\w-]*)(?:\s+([\s\S]*))?$/)
  if (!m) return null
  return { name: m[1]!, args: (m[2] ?? '').trim() }
}

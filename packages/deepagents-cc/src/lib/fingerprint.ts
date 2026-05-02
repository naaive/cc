/**
 * Pure denial fingerprint helpers.
 *
 * Lives in its own file so unit tests can verify the canonicalisation
 * without dragging the langchain runtime through `denialTracking.ts`.
 */

export function denialFingerprint(name: string, args: unknown): string {
  return `${name}:${stableJson(args)}`
}

export function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(',')}]`
  }
  const entries = Object.entries(value as Record<string, unknown>).sort(
    ([a], [b]) => a.localeCompare(b),
  )
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(',')}}`
}

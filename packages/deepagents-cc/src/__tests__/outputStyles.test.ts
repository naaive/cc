import { describe, expect, test } from 'bun:test'
import {
  formatOutputStyleSection,
  getOutputStyle,
  OUTPUT_STYLES,
} from '../outputStyles.js'

describe('OUTPUT_STYLES', () => {
  test('ships the three cc presets', () => {
    expect(OUTPUT_STYLES['concise']).toBeDefined()
    expect(OUTPUT_STYLES['explanatory']).toBeDefined()
    expect(OUTPUT_STYLES['learning']).toBeDefined()
  })

  test('preset prompts are non-trivial', () => {
    for (const style of Object.values(OUTPUT_STYLES)) {
      expect(style.prompt.length).toBeGreaterThan(40)
    }
  })
})

describe('getOutputStyle', () => {
  test('returns null for undefined name', () => {
    expect(getOutputStyle(undefined)).toBeNull()
  })

  test('looks up built-ins', () => {
    expect(getOutputStyle('concise')?.name).toBe('concise')
  })

  test('custom registry shadows built-ins', () => {
    const custom = {
      concise: { name: 'concise', prompt: 'OVERRIDE' },
    }
    expect(getOutputStyle('concise', custom)?.prompt).toBe('OVERRIDE')
  })

  test('returns null for unknown names', () => {
    expect(getOutputStyle('nonsense')).toBeNull()
  })
})

describe('formatOutputStyleSection', () => {
  test('renders with the # Output Style: <name> heading', () => {
    const out = formatOutputStyleSection(OUTPUT_STYLES['concise']!)
    expect(out.startsWith('# Output Style: concise')).toBe(true)
    expect(out).toContain(OUTPUT_STYLES['concise']!.prompt)
  })
})

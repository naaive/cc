import { describe, expect, test } from 'bun:test'
import { collectEnvironment } from '../env.js'

describe('collectEnvironment', () => {
  test('returns the current cwd by default', () => {
    const env = collectEnvironment({ detectGit: false })
    expect(env.cwd).toBe(process.cwd())
  })

  test('uses provided cwd and modelId', () => {
    const env = collectEnvironment({
      cwd: '/some/where',
      modelId: 'claude-haiku-4-5',
      detectGit: false,
    })
    expect(env.cwd).toBe('/some/where')
    expect(env.modelId).toBe('claude-haiku-4-5')
  })

  test('today is an ISO date', () => {
    const env = collectEnvironment({ detectGit: false })
    expect(env.today).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  test('platform is one of the known values', () => {
    const env = collectEnvironment({ detectGit: false })
    expect([
      'linux',
      'darwin',
      'win32',
      'freebsd',
      'openbsd',
      'sunos',
      'aix',
      'netbsd',
      'haiku',
      'cygwin',
      'android',
    ]).toContain(env.platform)
  })

  test('skips git detection when asked', () => {
    const env = collectEnvironment({ detectGit: false })
    expect(env.isGitRepo).toBe(false)
  })
})

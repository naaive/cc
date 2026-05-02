import { describe, expect, test } from 'bun:test'
import { createSkillActivator } from '../skills/activation.js'
import type { SkillMetadata } from '../skills/loader.js'

function s(
  name: string,
  activatePaths: string[],
): SkillMetadata {
  return {
    name,
    description: name,
    path: `/x/${name}/SKILL.md`,
    source: 'project',
    activatePaths,
  }
}

describe('createSkillActivator', () => {
  test('returns matched skill names on notice', () => {
    const a = createSkillActivator([
      s('auth', ['src/auth/**']),
      s('sql', ['**/*.sql']),
      s('ignored', ['nope/**']),
    ])
    expect(a.notice('/repo/src/auth/login.ts')).toEqual(['auth'])
    expect(a.notice('/repo/migrations/001.sql')).toEqual(['sql'])
    expect(a.notice('/repo/src/foo.ts')).toEqual([])
  })

  test('skips skills without activatePaths', () => {
    const a = createSkillActivator([
      { name: 'no-paths', description: '', path: '/x/SKILL.md', source: 'user' },
    ])
    expect(a.notice('/anywhere')).toEqual([])
  })

  test('drain is idempotent — fired skills don\'t fire again', () => {
    const a = createSkillActivator([s('auth', ['**/auth/**'])])
    expect(a.notice('/repo/src/auth/x.ts')).toEqual(['auth'])
    expect(a.drain()).toEqual(['auth'])
    expect(a.notice('/repo/src/auth/y.ts')).toEqual([])
    expect(a.drain()).toEqual([])
  })

  test('pending lists pending names without draining', () => {
    const a = createSkillActivator([s('auth', ['**/auth/**'])])
    a.notice('/repo/src/auth/x.ts')
    expect(a.pending()).toEqual(['auth'])
    expect(a.pending()).toEqual(['auth']) // still pending — not drained
    a.drain()
    expect(a.pending()).toEqual([])
  })

  test('explicit activate(name) queues without a Read', () => {
    const a = createSkillActivator([s('auth', ['**/auth/**'])])
    a.activate('auth')
    expect(a.drain()).toEqual(['auth'])
  })
})

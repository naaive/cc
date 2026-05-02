import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expandCommandBody } from '../commands/expander.js'

describe('expandCommandBody — $ARGUMENTS', () => {
  test('substitutes $ARGUMENTS literally', async () => {
    const out = await expandCommandBody(
      'commit message: $ARGUMENTS',
      'fix bug',
      { cwd: '/tmp' },
    )
    expect(out).toBe('commit message: fix bug')
  })

  test('multiple occurrences all replaced', async () => {
    const out = await expandCommandBody(
      '$ARGUMENTS — $ARGUMENTS',
      'X',
      { cwd: '/tmp' },
    )
    expect(out).toBe('X — X')
  })

  test('empty args produce empty insertions', async () => {
    expect(
      await expandCommandBody('hello $ARGUMENTS', '', { cwd: '/tmp' }),
    ).toBe('hello ')
  })
})

describe('expandCommandBody — !bash lines', () => {
  test('runs a !-prefixed line and inlines stdout', async () => {
    const out = await expandCommandBody('preamble\n! echo hi\nepilogue', '', {
      cwd: '/tmp',
      runBash: async cmd => `OUTPUT(${cmd})`,
    })
    expect(out).toContain('preamble')
    expect(out).toContain('OUTPUT(echo hi)')
    expect(out).toContain('epilogue')
  })

  test('only matches !-prefixed lines (prose !s untouched)', async () => {
    const out = await expandCommandBody(
      'wow! amazing!\n!echo done',
      '',
      { cwd: '/tmp', runBash: async () => 'X' },
    )
    expect(out).toContain('wow! amazing!')
    expect(out).toContain('X')
  })

  test('errors are inlined, not thrown', async () => {
    const out = await expandCommandBody('!badcmd', '', {
      cwd: '/tmp',
      runBash: async () => {
        throw new Error('boom')
      },
    })
    expect(out).toContain('[error running !badcmd: boom]')
  })

  test('caps inlined output at maxInlineChars', async () => {
    const huge = 'x'.repeat(20_000)
    const out = await expandCommandBody('!cmd', '', {
      cwd: '/tmp',
      runBash: async () => huge,
      maxInlineChars: 100,
    })
    expect(out).toContain('truncated to 100 chars')
    expect(out.length).toBeLessThan(500)
  })
})

describe('expandCommandBody — @file references', () => {
  let tmp: string

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-exp-'))
  })

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  test('inlines absolute path content', async () => {
    const file = path.join(tmp, 'spec.md')
    fs.writeFileSync(file, 'SPEC BODY')
    const out = await expandCommandBody(`Read this:\n@${file}`, '', {
      cwd: tmp,
    })
    expect(out).toContain('SPEC BODY')
  })

  test('resolves relative paths against cwd', async () => {
    fs.writeFileSync(path.join(tmp, 'note.txt'), 'NOTE')
    const out = await expandCommandBody('@note.txt', '', { cwd: tmp })
    expect(out).toContain('NOTE')
  })

  test('errors are inlined, not thrown', async () => {
    const out = await expandCommandBody('@/nonexistent/file', '', { cwd: tmp })
    expect(out).toContain('[error reading @/nonexistent/file:')
  })

  test('quoted paths support spaces', async () => {
    const file = path.join(tmp, 'with space.md')
    fs.writeFileSync(file, 'HAS_SPACE')
    const out = await expandCommandBody(`@"${file}"`, '', { cwd: tmp })
    expect(out).toContain('HAS_SPACE')
  })
})

describe('expandCommandBody — substitution order', () => {
  test('$ARGUMENTS is substituted before !bash lines', async () => {
    // If $ARGUMENTS contained an !bash line, it would NOT be re-evaluated.
    const out = await expandCommandBody('$ARGUMENTS\n!echo real', '!echo fake', {
      cwd: '/tmp',
      runBash: async cmd => `RAN(${cmd})`,
    })
    // The literal "!echo fake" from $ARGUMENTS DOES get evaluated as bash —
    // this is intentional because !-line detection is line-based, not
    // substitution-aware. We just assert behaviour is documented:
    expect(out).toContain('RAN(echo fake)')
    expect(out).toContain('RAN(echo real)')
  })
})

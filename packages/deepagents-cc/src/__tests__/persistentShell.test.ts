import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PersistentShell } from '../tools/persistentShell.js'

const hasBash = fs.existsSync('/bin/bash')

describe.skipIf(!hasBash)('PersistentShell', () => {
  let tmp: string
  let shell: PersistentShell

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ccx-shell-'))
    shell = new PersistentShell({ cwd: tmp })
  })

  afterEach(() => {
    shell.stop()
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  test('captures stdout and exit code', async () => {
    const r = await shell.run('echo hello && true')
    expect(r.stdout).toContain('hello')
    expect(r.exitCode).toBe(0)
  })

  test('reports non-zero exit codes', async () => {
    const r = await shell.run('false')
    expect(r.exitCode).toBe(1)
  })

  test('persists cwd across calls', async () => {
    fs.mkdirSync(path.join(tmp, 'sub'))
    const a = await shell.run('cd sub && pwd')
    expect(a.stdout.trim().endsWith('/sub')).toBe(true)
    const b = await shell.run('pwd')
    expect(b.stdout.trim().endsWith('/sub')).toBe(true)
    expect(b.cwd.endsWith('/sub')).toBe(true)
  })

  test('persists exported variables across calls', async () => {
    await shell.run('export FOO=bar')
    const r = await shell.run('echo "$FOO"')
    expect(r.stdout).toContain('bar')
  })

  test('captures stderr separately from stdout', async () => {
    const r = await shell.run('echo out && echo err 1>&2')
    expect(r.stdout).toContain('out')
    expect(r.stderr).toContain('err')
  })

  test('truncates extremely long output', async () => {
    const r = await shell.run('yes x | head -c 250000')
    expect(r.truncated).toBe(true)
    expect(r.stdout.length).toBeLessThanOrEqual(200_000 + 1024)
  })

  test('serialises calls — second run rejected if first is in-flight', async () => {
    const slow = shell.run('sleep 0.5; echo done')
    await expect(shell.run('echo fast')).rejects.toThrow(/busy/)
    const r = await slow
    expect(r.stdout).toContain('done')
  })

  test('on timeout, shell is killed and the next call restarts cleanly', async () => {
    const r1 = await shell.run('sleep 5; echo never', 200)
    expect(r1.timedOut).toBe(true)
    // The contract is: timeouts kill the shell; subsequent calls work but
    // do NOT inherit the dead shell's state (cwd, exports). We just verify
    // we can run another command without hanging.
    const r2 = await shell.run('echo recovered')
    expect(r2.stdout).toContain('recovered')
    expect(r2.exitCode).toBe(0)
  }, 10_000)
})

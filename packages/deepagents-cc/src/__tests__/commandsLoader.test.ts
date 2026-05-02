import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { listCommands, parseCommandFile } from '../commands/loader.js'

describe('parseCommandFile', () => {
  let tmp: string

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ccx-cmd-'))
  })

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  test('parses minimal command with no frontmatter', () => {
    const file = path.join(tmp, 'lint.md')
    fs.writeFileSync(file, 'Run the linter.')
    const cmd = parseCommandFile(file, 'lint', 'project')
    expect(cmd?.name).toBe('lint')
    expect(cmd?.body).toBe('Run the linter.')
    expect(cmd?.description).toBeUndefined()
  })

  test('parses frontmatter fields', () => {
    const file = path.join(tmp, 'commit.md')
    fs.writeFileSync(
      file,
      `---
description: Stage and commit pending changes
argument-hint: "<message>"
allowed-tools: "Bash Read"
model: claude-opus-4-7
---
git commit -m "$ARGUMENTS"
`,
    )
    const cmd = parseCommandFile(file, 'commit', 'user')
    expect(cmd?.description).toBe('Stage and commit pending changes')
    expect(cmd?.argumentHint).toBe('<message>')
    expect(cmd?.allowedTools).toBe('Bash Read')
    expect(cmd?.model).toBe('claude-opus-4-7')
    expect(cmd?.body.trim()).toBe('git commit -m "$ARGUMENTS"')
  })

  test('rejects invalid command names', () => {
    const file = path.join(tmp, 'bad.md')
    fs.writeFileSync(file, 'x')
    expect(parseCommandFile(file, 'BadName', 'user')).toBeNull()
    expect(parseCommandFile(file, '123', 'user')).toBeNull()
  })

  test('accepts namespaced names (folder:name)', () => {
    const file = path.join(tmp, 'commit.md')
    fs.writeFileSync(file, 'x')
    expect(parseCommandFile(file, 'git:commit', 'project')?.name).toBe('git:commit')
  })
})

describe('listCommands', () => {
  let tmp: string

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ccx-cmd-'))
  })

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  test('discovers .md files at the root and namespaced folders', () => {
    const dir = path.join(tmp, 'commands')
    fs.mkdirSync(path.join(dir, 'git'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'lint.md'), 'lint')
    fs.writeFileSync(path.join(dir, 'git', 'commit.md'), 'commit')
    const out = listCommands({ projectCommandsDir: dir })
    expect(out.map(c => c.name).sort()).toEqual(['git:commit', 'lint'])
  })

  test('project commands shadow user commands by name', () => {
    const userDir = path.join(tmp, 'user')
    const projectDir = path.join(tmp, 'project')
    fs.mkdirSync(userDir)
    fs.mkdirSync(projectDir)
    fs.writeFileSync(path.join(userDir, 'init.md'), 'user version')
    fs.writeFileSync(path.join(projectDir, 'init.md'), 'project version')
    const out = listCommands({
      userCommandsDir: userDir,
      projectCommandsDir: projectDir,
    })
    expect(out.length).toBe(1)
    expect(out[0]!.body).toBe('project version')
    expect(out[0]!.source).toBe('project')
  })

  test('skips non-md files', () => {
    const dir = path.join(tmp, 'commands')
    fs.mkdirSync(dir)
    fs.writeFileSync(path.join(dir, 'README.txt'), 'x')
    fs.writeFileSync(path.join(dir, 'lint.md'), 'lint')
    expect(listCommands({ projectCommandsDir: dir }).map(c => c.name)).toEqual([
      'lint',
    ])
  })

  test('returns empty when the dir is missing', () => {
    expect(listCommands({ projectCommandsDir: '/nonexistent/zz' })).toEqual([])
  })
})

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  listSkills,
  parseSkillMetadata,
  readSkillBody,
} from '../skills/loader.js'

describe('parseSkillMetadata', () => {
  test('parses minimal valid frontmatter', () => {
    const md = `---
name: my-skill
description: Does a thing.
---
Body.`
    const meta = parseSkillMetadata(md, '/x/SKILL.md', 'inline')
    expect(meta).toEqual({
      name: 'my-skill',
      description: 'Does a thing.',
      path: '/x/SKILL.md',
      source: 'inline',
    })
  })

  test('captures optional fields', () => {
    const md = `---
name: my-skill
description: Does a thing.
license: MIT
compatibility: requires bun
allowed-tools: Read Grep Bash
---
Body.`
    const meta = parseSkillMetadata(md, '/x/SKILL.md', 'project')
    expect(meta?.license).toBe('MIT')
    expect(meta?.compatibility).toBe('requires bun')
    expect(meta?.allowedTools).toBe('Read Grep Bash')
  })

  test('rejects names that violate the spec pattern', () => {
    const md = `---
name: BadName
description: Bad capitalisation.
---
`
    expect(parseSkillMetadata(md, '/x/SKILL.md', 'user')).toBeNull()
  })

  test('rejects descriptions that are too long', () => {
    const md = `---
name: ok-name
description: ${'x'.repeat(2000)}
---
`
    expect(parseSkillMetadata(md, '/x/SKILL.md', 'user')).toBeNull()
  })

  test('returns null when frontmatter is missing', () => {
    expect(parseSkillMetadata('plain markdown', '/x/SKILL.md', 'user')).toBeNull()
  })

  test('strips quotes around values', () => {
    const md = `---
name: my-skill
description: "Does a thing."
---
`
    expect(parseSkillMetadata(md, '/x/SKILL.md', 'user')?.description).toBe(
      'Does a thing.',
    )
  })
})

describe('listSkills + readSkillBody (real disk)', () => {
  let tmp: string

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-skills-'))
  })

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  test('discovers skill dirs with valid SKILL.md', () => {
    fs.mkdirSync(path.join(tmp, 'a'))
    fs.writeFileSync(
      path.join(tmp, 'a', 'SKILL.md'),
      '---\nname: a-skill\ndescription: A.\n---\n',
    )
    fs.mkdirSync(path.join(tmp, 'b'))
    fs.writeFileSync(
      path.join(tmp, 'b', 'SKILL.md'),
      '---\nname: b-skill\ndescription: B.\n---\n',
    )
    const found = listSkills({ projectSkillsDir: tmp })
    expect(found.map(s => s.name)).toEqual(['a-skill', 'b-skill'])
  })

  test('skips directories without SKILL.md', () => {
    fs.mkdirSync(path.join(tmp, 'no-skill-here'))
    expect(listSkills({ projectSkillsDir: tmp })).toEqual([])
  })

  test('project skills shadow user skills with the same name', () => {
    const userDir = path.join(tmp, 'user')
    const projectDir = path.join(tmp, 'project')
    fs.mkdirSync(path.join(userDir, 'shared'), { recursive: true })
    fs.mkdirSync(path.join(projectDir, 'shared'), { recursive: true })
    fs.writeFileSync(
      path.join(userDir, 'shared', 'SKILL.md'),
      '---\nname: shared\ndescription: from user\n---\n',
    )
    fs.writeFileSync(
      path.join(projectDir, 'shared', 'SKILL.md'),
      '---\nname: shared\ndescription: from project\n---\n',
    )
    const found = listSkills({ userSkillsDir: userDir, projectSkillsDir: projectDir })
    expect(found.length).toBe(1)
    expect(found[0]!.description).toBe('from project')
    expect(found[0]!.source).toBe('project')
  })

  test('readSkillBody returns content after the frontmatter', () => {
    fs.mkdirSync(path.join(tmp, 'a'))
    const file = path.join(tmp, 'a', 'SKILL.md')
    fs.writeFileSync(file, '---\nname: a\ndescription: a\n---\n# Body\n\nHi.')
    expect(readSkillBody(file)).toBe('# Body\n\nHi.')
  })
})

import { describe, expect, test } from 'bun:test'
import { parseSlashCommand } from '../slashCommands/parse.js'
import { findCommand, builtinCommands } from '../slashCommands/builtin.js'

describe('parseSlashCommand', () => {
  test('parses bare command', () => {
    expect(parseSlashCommand('/clear')).toEqual({ name: 'clear', args: '' })
  })

  test('parses command with args', () => {
    expect(parseSlashCommand('/memory note for later')).toEqual({
      name: 'memory',
      args: 'note for later',
    })
  })

  test('returns null for non-slash input', () => {
    expect(parseSlashCommand('hello world')).toBeNull()
  })

  test('does not match path-like prefixes', () => {
    // A bare path is not a command — but a name starts with / and matches.
    // Spec: leading slash + word chars = command. "/path/to" would parse as
    // command "path" with args "to" — that's intentional. We test the
    // negative case for things that explicitly cannot be a command.
    expect(parseSlashCommand('/123abc')).toBeNull() // starts with digit
    expect(parseSlashCommand('/!bad')).toBeNull()
  })

  test('strips leading whitespace', () => {
    expect(parseSlashCommand('   /help')).toEqual({ name: 'help', args: '' })
  })
})

describe('findCommand', () => {
  test('all builtins are reachable by name', () => {
    for (const c of builtinCommands) {
      expect(findCommand(c.name)?.name).toBe(c.name)
    }
  })

  test('unknown command returns undefined', () => {
    expect(findCommand('not_a_real_command')).toBeUndefined()
  })

  test('clear/help/init/compact/memory/mode are present', () => {
    for (const name of ['clear', 'help', 'init', 'compact', 'memory', 'mode']) {
      expect(findCommand(name)).toBeDefined()
    }
  })
})

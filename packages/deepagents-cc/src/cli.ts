#!/usr/bin/env bun
/**
 * Minimal CLI — `ccx`. Two modes:
 *   - headless: `ccx -p "prompt"` or `echo "prompt" | ccx -p` runs once and prints.
 *   - REPL:     plain `ccx` reads stdin in a loop, supports slash commands.
 *
 * Real cc has a full Ink REPL — out of scope here. This is the pipe-friendly
 * baseline that proves the wiring works end-to-end.
 */

import { createInterface } from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'
import { createClaudeCodeAgent } from './agent.js'
import { parseSlashCommand } from './slashCommands/parse.js'
import { findCommand } from './slashCommands/builtin.js'
import type { PermissionMode } from './permissionMode.js'

interface CliFlags {
  prompt?: string
  headless: boolean
  cwd?: string
  model?: string
  showHelp: boolean
}

function parseFlags(argv: string[]): CliFlags {
  const flags: CliFlags = { headless: false, showHelp: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg === '-p' || arg === '--print') {
      flags.headless = true
      const next = argv[i + 1]
      if (next && !next.startsWith('-')) {
        flags.prompt = next
        i++
      }
    } else if (arg === '--cwd') {
      flags.cwd = argv[++i]
    } else if (arg === '--model') {
      flags.model = argv[++i]
    } else if (arg === '-h' || arg === '--help') {
      flags.showHelp = true
    } else if (!flags.prompt) {
      flags.prompt = arg
    }
  }
  return flags
}

const HELP = `ccx — Claude Code-on-LangChain

Usage:
  ccx                        Interactive REPL.
  ccx -p "<prompt>"          Headless: run once, print the answer.
  echo "..." | ccx -p        Read prompt from stdin.

Flags:
  --cwd <dir>     Working directory (default: $PWD).
  --model <id>    Model id (default: from settings or claude-sonnet-4-6).
  -h, --help      Show this help.

Slash commands inside the REPL:
  /clear /help /init /compact /memory /mode
`

async function readStdin(): Promise<string> {
  if (input.isTTY) return ''
  const chunks: Buffer[] = []
  for await (const chunk of input) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks).toString('utf8').trim()
}

async function main() {
  const flags = parseFlags(process.argv.slice(2))
  if (flags.showHelp) {
    process.stdout.write(HELP)
    return
  }

  if (flags.headless && !flags.prompt) {
    flags.prompt = await readStdin()
  }

  const { agent } = createClaudeCodeAgent({
    cwd: flags.cwd,
    model: flags.model,
  })

  if (flags.headless) {
    if (!flags.prompt) {
      process.stderr.write('No prompt provided. Use -p "..." or pipe stdin.\n')
      process.exit(2)
    }
    const result = await agent.invoke({
      messages: [{ role: 'user', content: flags.prompt }],
    })
    const last = result.messages?.[result.messages.length - 1]
    process.stdout.write(messageToText(last) + '\n')
    return
  }

  // REPL
  const messages: Array<{ role: string; content: string }> = []
  let permissionMode: PermissionMode = 'default'
  const rl = createInterface({ input, output })
  process.stdout.write('ccx — Claude Code on LangChain. Type /help for commands.\n')
  while (true) {
    const line = await rl.question(`[${permissionMode}] > `).catch(() => null)
    if (line == null) break
    if (!line.trim()) continue

    const slash = parseSlashCommand(line)
    if (slash) {
      const cmd = findCommand(slash.name)
      if (!cmd) {
        process.stdout.write(`Unknown command: /${slash.name}\n`)
        continue
      }
      await cmd.run(slash.args, {
        cwd: flags.cwd ?? process.cwd(),
        setPermissionMode: m => {
          permissionMode = m
        },
        clearHistory: () => {
          messages.length = 0
        },
        appendMemory: () => {
          // No-op in this minimal CLI — real cc writes to disk.
        },
        print: text => process.stdout.write(text + '\n'),
      })
      continue
    }

    messages.push({ role: 'user', content: line })
    const result = await agent.invoke({ messages })
    const last = result.messages?.[result.messages.length - 1]
    const text = messageToText(last)
    process.stdout.write(text + '\n')
    messages.push({ role: 'assistant', content: text })
  }
  rl.close()
}

function messageToText(msg: unknown): string {
  if (!msg || typeof msg !== 'object') return ''
  const m = msg as { content?: unknown }
  if (typeof m.content === 'string') return m.content
  if (Array.isArray(m.content)) {
    return m.content
      .map((part: unknown) => {
        if (typeof part === 'string') return part
        if (
          typeof part === 'object' &&
          part != null &&
          'text' in part &&
          typeof (part as { text: unknown }).text === 'string'
        ) {
          return (part as { text: string }).text
        }
        return ''
      })
      .filter(Boolean)
      .join('')
  }
  return ''
}

main().catch(err => {
  process.stderr.write(`fatal: ${(err as Error).stack ?? err}\n`)
  process.exit(1)
})

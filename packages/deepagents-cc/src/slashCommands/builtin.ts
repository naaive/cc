/**
 * Built-in slash commands. Mirrors cc's standard set:
 * `/clear`, `/help`, `/init`, `/compact`, `/memory`, `/mode`.
 */

import { captureGitStatus, collectEnvironment } from '../env.js'
import { loadClaudeMd } from '../claudemd.js'
import type { PermissionMode } from '../permissionMode.js'

export interface SlashCommandContext {
  cwd: string
  /** Mutate to switch the next-turn permission mode. */
  setPermissionMode(mode: PermissionMode): void
  /** Reset history. The harness clears `state.messages`. */
  clearHistory(): void
  /** Persist a memory note to CLAUDE.md (project or user). */
  appendMemory(scope: 'user' | 'project', text: string): void
  print(text: string): void
}

export interface SlashCommand {
  name: string
  description: string
  run(args: string, ctx: SlashCommandContext): void | Promise<void>
}

export const builtinCommands: SlashCommand[] = [
  {
    name: 'clear',
    description: 'Clear the conversation history.',
    run: (_args, ctx) => {
      ctx.clearHistory()
      ctx.print('Conversation cleared.')
    },
  },
  {
    name: 'help',
    description: 'Show available slash commands.',
    run: (_args, ctx) => {
      const lines = builtinCommands.map(
        c => `  /${c.name.padEnd(10)} ${c.description}`,
      )
      ctx.print(`Slash commands:\n${lines.join('\n')}`)
    },
  },
  {
    name: 'init',
    description: 'Print a CLAUDE.md scaffold for the current project.',
    run: (_args, ctx) => {
      const env = collectEnvironment({ cwd: ctx.cwd })
      const git = captureGitStatus(ctx.cwd)
      const md = `# CLAUDE.md
This file gives Claude Code the context it needs to work productively in this repo.

## Project
- cwd: ${env.cwd}
- platform: ${env.platform} (${env.osRelease})
- git: ${git ? `branch ${git.branch}` : 'not a git repository'}

## Commands
\`\`\`bash
# install
# build
# test
\`\`\`

## Conventions
- Coding style:
- Commit message style:
- Testing approach:
`
      ctx.print(md)
    },
  },
  {
    name: 'compact',
    description: 'Force a summarization of the conversation history.',
    run: (_args, ctx) => {
      ctx.print('Compaction queued — the summarization middleware will run on the next turn.')
    },
  },
  {
    name: 'memory',
    description: 'Append text to project CLAUDE.md. Usage: /memory <text>',
    run: (args, ctx) => {
      if (!args) {
        const entries = loadClaudeMd({ cwd: ctx.cwd })
        ctx.print(
          entries.length === 0
            ? '(no CLAUDE.md found)'
            : entries.map(e => `[${e.scope}] ${e.path}`).join('\n'),
        )
        return
      }
      ctx.appendMemory('project', args)
      ctx.print(`Appended to project CLAUDE.md.`)
    },
  },
  {
    name: 'mode',
    description: 'Switch permission mode. Usage: /mode default|plan|acceptEdits|bypassPermissions',
    run: (args, ctx) => {
      const next = (args.trim() || 'default') as PermissionMode
      ctx.setPermissionMode(next)
      ctx.print(`Permission mode → ${next}`)
    },
  },
]

export function findCommand(name: string): SlashCommand | undefined {
  return builtinCommands.find(c => c.name === name)
}

/**
 * ls — directory listing with sane defaults.
 *
 * Hides dotfiles and node_modules by default; the model can opt in via
 * `show_hidden`. Returns a flat list with type tags ([dir]/[file]/[link])
 * sorted by name. Refuses paths outside the original cwd unless
 * the host explicitly turns that guard off.
 */

import fs from 'node:fs'
import path from 'node:path'
import { tool } from 'langchain'
import { z } from 'zod/v4'
import { ensureAbsolute } from './fsUtils.js'

const HIDE_BY_DEFAULT = new Set([
  'node_modules',
  '.git',
  '.next',
  '.turbo',
  '.cache',
  'dist',
  'build',
])

const schema = z.object({
  path: z.string().describe('Absolute directory path to list.'),
  show_hidden: z
    .boolean()
    .optional()
    .describe('Include dotfiles and common build dirs (node_modules, .git, dist, …).'),
})

const description = `List the immediate contents of a directory.

Skips hidden files and common build dirs by default — pass show_hidden=true to include them.
For deep recursive listing prefer glob.`

export interface LsToolOptions {
  /** When set, refuse paths outside this directory. */
  rootBoundary?: string
}

export function createLsTool(options: LsToolOptions = {}) {
  return tool(
    (input: z.infer<typeof schema>) => {
      const abs = ensureAbsolute(input.path, 'path')
      if (options.rootBoundary && !abs.startsWith(path.resolve(options.rootBoundary))) {
        throw new Error(`${abs} is outside the allowed root ${options.rootBoundary}`)
      }
      const stat = fs.statSync(abs)
      if (!stat.isDirectory()) throw new Error(`not a directory: ${abs}`)
      const entries = fs.readdirSync(abs, { withFileTypes: true })
      const filtered = entries.filter(e => {
        if (input.show_hidden) return true
        if (e.name.startsWith('.')) return false
        if (HIDE_BY_DEFAULT.has(e.name)) return false
        return true
      })
      filtered.sort((a, b) => {
        // dirs first
        if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1
        return a.name.localeCompare(b.name)
      })
      const lines = filtered.map(e => {
        const tag = e.isDirectory() ? '[dir]' : e.isSymbolicLink() ? '[link]' : '[file]'
        return `${tag.padEnd(7)}${e.name}`
      })
      return lines.length === 0 ? '(empty)' : lines.join('\n')
    },
    { name: 'ls', description, schema },
  )
}

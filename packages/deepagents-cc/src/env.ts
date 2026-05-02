/**
 * Environment introspection used by the cc-style system prompt.
 *
 * Mirrors what cc injects into its system prompt: cwd, platform, OS version,
 * git status, model id, and the date. Kept dependency-light so it works in
 * sandboxed runs (no shell out unless explicitly requested).
 */

import { execSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export interface EnvironmentInfo {
  cwd: string
  platform: NodeJS.Platform
  osRelease: string
  shell: string
  isGitRepo: boolean
  /** ISO date, no time. */
  today: string
  modelId: string
}

export interface CollectEnvOptions {
  cwd?: string
  modelId?: string
  /** When false, skip git detection (faster, no fork/exec). */
  detectGit?: boolean
}

export function collectEnvironment(
  options: CollectEnvOptions = {},
): EnvironmentInfo {
  const cwd = options.cwd ?? process.cwd()
  return {
    cwd,
    platform: process.platform,
    osRelease: safe(() => `${os.type()} ${os.release()}`),
    shell: process.env.SHELL ?? 'unknown',
    isGitRepo:
      options.detectGit === false ? false : detectGitRepo(cwd),
    today: new Date().toISOString().slice(0, 10),
    modelId: options.modelId ?? process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-6',
  }
}

function safe<T>(fn: () => T, fallback?: T): T {
  try {
    return fn()
  } catch {
    return fallback as T
  }
}

function detectGitRepo(cwd: string): boolean {
  let current = path.resolve(cwd)
  while (current !== path.dirname(current)) {
    if (fs.existsSync(path.join(current, '.git'))) return true
    current = path.dirname(current)
  }
  return false
}

/**
 * Capture short `git status` and current branch — used by /init-style flows.
 * Throws nothing: returns null on any failure.
 */
export function captureGitStatus(cwd: string): {
  branch: string
  short: string
} | null {
  try {
    const branch = execSync('git rev-parse --abbrev-ref HEAD', {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    const short = execSync('git status --short', {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    return { branch, short }
  } catch {
    return null
  }
}

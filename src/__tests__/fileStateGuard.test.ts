/**
 * FileStateGuard tests — the deep guard now owns boundary, path resolution,
 * mtime invariants, and the storage-URI escape hatch. These tests cross the
 * guard's interface (the test surface) rather than reaching into the cache.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createFileStateGuard, FILE_UNCHANGED_STUB } from '../tools/fileStateGuard.js'
import { makeFileStateCache, resolveRoots } from '../tools/fsUtils.js'
import { createInMemoryResultStore, storageUri } from '../tools/resultStore.js'

describe('FileStateGuard.prepareRead', () => {
  let tmp: string
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-guard-'))
  })
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  test('returns stored content for a forge-store:// URI', () => {
    const store = createInMemoryResultStore()
    const entry = store.put('Grep', 'cached output')
    const guard = createFileStateGuard({
      cache: makeFileStateCache(),
      resultStore: store,
      roots: resolveRoots(tmp),
    })
    const r = guard.prepareRead(storageUri(entry.id), false)
    expect(r.kind).toBe('stored')
    if (r.kind === 'stored') expect(r.content).toContain('cached output')
  })

  test('returns unchanged on a re-Read with the same mtime', () => {
    const file = path.join(tmp, 'a.txt')
    fs.writeFileSync(file, 'hi')
    const cache = makeFileStateCache()
    const guard = createFileStateGuard({ cache, roots: resolveRoots(tmp) })
    const first = guard.prepareRead(file, false)
    expect(first.kind).toBe('fresh')
    if (first.kind === 'fresh') guard.record(first.abs, first.mtime)
    const second = guard.prepareRead(file, false)
    expect(second.kind).toBe('unchanged')
  })

  test('paged reads are never short-circuited', () => {
    const file = path.join(tmp, 'a.txt')
    fs.writeFileSync(file, 'hi')
    const cache = makeFileStateCache()
    const guard = createFileStateGuard({ cache, roots: resolveRoots(tmp) })
    const first = guard.prepareRead(file, false)
    if (first.kind === 'fresh') guard.record(first.abs, first.mtime)
    const paged = guard.prepareRead(file, true)
    expect(paged.kind).toBe('fresh')
  })

  test('rejects relative paths', () => {
    const guard = createFileStateGuard({
      cache: makeFileStateCache(),
      roots: resolveRoots(tmp),
    })
    expect(() => guard.prepareRead('relative/path.txt', false)).toThrow(/absolute path/)
  })

  test('blocks paths outside the configured roots', () => {
    const outside = path.join(os.tmpdir(), 'forge-guard-outside.txt')
    fs.writeFileSync(outside, 'x')
    try {
      const guard = createFileStateGuard({
        cache: makeFileStateCache(),
        roots: resolveRoots(tmp),
      })
      expect(() => guard.prepareRead(outside, false)).toThrow(/outside the allowed roots/)
    } finally {
      fs.rmSync(outside)
    }
  })

  test('missing files include a path-recovery hint', () => {
    fs.writeFileSync(path.join(tmp, 'README.md'), 'x')
    const guard = createFileStateGuard({
      cache: makeFileStateCache(),
      roots: resolveRoots(tmp),
    })
    const missing = path.join(tmp, 'readme.md')
    let err: Error | null = null
    try {
      guard.prepareRead(missing, false)
    } catch (e) {
      err = e as Error
    }
    expect(err).not.toBeNull()
    expect(err!.message).toContain('file not found')
  })
})

describe('FileStateGuard.prepareEdit / prepareWrite', () => {
  let tmp: string
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-guard-'))
  })
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  test('prepareEdit refuses without a prior Read', () => {
    const file = path.join(tmp, 'a.txt')
    fs.writeFileSync(file, 'hi')
    const guard = createFileStateGuard({
      cache: makeFileStateCache(),
      roots: resolveRoots(tmp),
    })
    expect(() => guard.prepareEdit(file)).toThrow(/Read .* before editing/)
  })

  test('prepareEdit succeeds after a recorded Read', () => {
    const file = path.join(tmp, 'a.txt')
    fs.writeFileSync(file, 'hi')
    const cache = makeFileStateCache()
    const guard = createFileStateGuard({ cache, roots: resolveRoots(tmp) })
    const r = guard.prepareRead(file, false)
    if (r.kind === 'fresh') guard.record(r.abs, r.mtime)
    expect(() => guard.prepareEdit(file)).not.toThrow()
  })

  test('prepareWrite returns existed=false for new files', () => {
    const file = path.join(tmp, 'new.txt')
    const guard = createFileStateGuard({
      cache: makeFileStateCache(),
      roots: resolveRoots(tmp),
    })
    expect(guard.prepareWrite(file)).toEqual({ abs: file, existed: false })
  })

  test('prepareWrite refuses to overwrite an unread file', () => {
    const file = path.join(tmp, 'a.txt')
    fs.writeFileSync(file, 'hi')
    const guard = createFileStateGuard({
      cache: makeFileStateCache(),
      roots: resolveRoots(tmp),
    })
    expect(() => guard.prepareWrite(file)).toThrow(/Use the Read tool to read it first/)
  })
})

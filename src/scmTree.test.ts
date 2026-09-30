import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  filesForSection,
  mergeRepoChanges,
  primaryScmSection,
  nestChangePaths,
  relativeRepoPath,
  repoSectionHasFiles,
} from './scmTree'

describe('relativeRepoPath', () => {
  it('returns posix-style path under repo root', () => {
    const root = '/Volumes/Code/repos/lobbs'
    assert.equal(relativeRepoPath(root, `${root}/lobbs/Lobbs.h`), 'lobbs/Lobbs.h')
  })
})

describe('mergeRepoChanges', () => {
  it('dedupes a path that appears in staged and working tree', () => {
    const root = '/repo'
    const merged = mergeRepoChanges(
      root,
      [{ uri: { fsPath: '/repo/a.txt' } }],
      [{ uri: { fsPath: '/repo/a.txt' } }],
      []
    )
    assert.equal(merged.length, 1)
    assert.deepEqual(merged[0].states.sort(), ['changes', 'staged'])
  })
})

describe('filesForSection', () => {
  it('lists the same path in staged and changes sections when both apply', () => {
    const root = '/repo'
    const merged = mergeRepoChanges(
      root,
      [{ uri: { fsPath: '/repo/a.txt' } }],
      [{ uri: { fsPath: '/repo/a.txt' } }],
      []
    )
    assert.equal(filesForSection(merged, 'staged').length, 1)
    assert.equal(filesForSection(merged, 'changes').length, 1)
    assert.equal(filesForSection(merged, 'merge').length, 0)
  })

  it('returns empty for empty merged input', () => {
    assert.equal(filesForSection([], 'staged').length, 0)
    assert.equal(repoSectionHasFiles([], 'changes'), false)
  })
})

describe('primaryScmSection', () => {
  it('prefers merge and working tree over staged for decoration', () => {
    assert.equal(primaryScmSection(['staged', 'changes']), 'changes')
    assert.equal(primaryScmSection(['staged', 'merge']), 'merge')
    assert.equal(primaryScmSection(['staged']), 'staged')
  })
})

describe('nestChangePaths', () => {
  it('nests paths in tree mode', () => {
    const nested = nestChangePaths(
      [
        { relativePath: 'lobbs/Lobbs.h', name: 'Lobbs.h', states: ['changes'] },
        { relativePath: 'extra.py', name: 'extra.py', states: ['staged'] },
      ],
      false
    )
    assert.equal(nested.length, 2)
    const dir = nested.find((n) => n.kind === 'dir')
    assert.ok(dir && dir.kind === 'dir')
    assert.equal(dir.name, 'lobbs')
    assert.equal(dir.children.length, 1)
    assert.equal(dir.children[0].kind, 'file')
  })

  it('returns a flat file list in flat mode', () => {
    const nested = nestChangePaths(
      [{ relativePath: 'a/b.txt', name: 'b.txt', states: ['changes'] }],
      true
    )
    assert.equal(nested.length, 1)
    assert.equal(nested[0].kind, 'file')
  })
})

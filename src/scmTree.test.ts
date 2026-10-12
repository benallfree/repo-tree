import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  filesForSection,
  indexSectionChanges,
  mergeRepoChanges,
  nestChangePaths,
  nestedDirChildren,
  pathListSignature,
  type MergedChangeFile,
  pathsInSectionUnderDir,
  pathsUnderDir,
  primaryScmSection,
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
    const staged = filesForSection(merged, 'staged')
    const changes = filesForSection(merged, 'changes')
    assert.equal(staged.length, 1)
    assert.equal(changes.length, 1)
    assert.equal(filesForSection(merged, 'merge').length, 0)
    assert.equal(staged.filter((f) => f.relativePath === 'a.txt').length, 1)
    assert.equal(changes.filter((f) => f.relativePath === 'a.txt').length, 1)
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

describe('pathsInSectionUnderDir', () => {
  const merged = mergeRepoChanges(
    '/repo',
    [{ uri: { fsPath: '/repo/samples/a.txt' } }],
    [
      { uri: { fsPath: '/repo/samples/b.txt' } },
      { uri: { fsPath: '/repo/other/c.txt' } },
    ],
    []
  )

  it('returns all paths in section at section root', () => {
    const staged = pathsInSectionUnderDir(merged, 'staged', '')
    assert.deepEqual(staged.sort(), ['samples/a.txt'])
    const changes = pathsInSectionUnderDir(merged, 'changes', '')
    assert.deepEqual(changes.sort(), ['other/c.txt', 'samples/b.txt'])
  })

  it('filters by directory prefix within section only', () => {
    assert.deepEqual(pathsInSectionUnderDir(merged, 'changes', 'samples'), ['samples/b.txt'])
    assert.deepEqual(pathsInSectionUnderDir(merged, 'staged', 'samples'), ['samples/a.txt'])
    assert.deepEqual(pathsInSectionUnderDir(merged, 'staged', 'other'), [])
  })
})

describe('pathsUnderDir', () => {
  const merged = mergeRepoChanges(
    '/repo',
    [{ uri: { fsPath: '/repo/samples/a.txt' } }],
    [{ uri: { fsPath: '/repo/samples/b.txt' } }],
    [{ uri: { fsPath: '/repo/other/m.txt' } }]
  )

  it('returns all merged paths under a directory prefix', () => {
    assert.deepEqual(pathsUnderDir(merged, 'samples').sort(), ['samples/a.txt', 'samples/b.txt'])
    assert.deepEqual(pathsUnderDir(merged, '').sort(), ['other/m.txt', 'samples/a.txt', 'samples/b.txt'])
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

  it('nests thousands of sibling files under one directory', () => {
    const files: MergedChangeFile[] = Array.from({ length: 5000 }, (_, i) => ({
      relativePath: `links/3200peak/peak-${i}.json`,
      name: `peak-${i}.json`,
      states: ['changes'],
    }))
    const started = Date.now()
    const nested = nestChangePaths(files, false)
    const elapsed = Date.now() - started
    assert.equal(nested.length, 1)
    const links = nested[0]
    assert.ok(links.kind === 'dir')
    const peak = links.children[0]
    assert.ok(peak.kind === 'dir')
    assert.equal(peak.children.length, 5000)
    assert.equal(peak.children[0].kind === 'file' && peak.children[0].name, 'peak-0.json')
    assert.equal(peak.children[2].kind === 'file' && peak.children[2].name, 'peak-2.json')
    assert.equal(peak.children[10].kind === 'file' && peak.children[10].name, 'peak-10.json')
    assert.ok(elapsed < 1500, `nest took ${elapsed}ms`)
    assert.equal(nestedDirChildren(nested).get('links/3200peak')?.length, 5000)
  })
})

describe('pathListSignature', () => {
  it('changes when order or membership changes', () => {
    assert.equal(pathListSignature(['a', 'b']), pathListSignature(['a', 'b']))
    assert.notEqual(pathListSignature(['a', 'b']), pathListSignature(['b', 'a']))
    assert.notEqual(pathListSignature(['a']), pathListSignature(['a', 'b']))
  })
})

describe('indexSectionChanges', () => {
  it('lets a working-tree entry override an untracked entry for the same path', () => {
    const map = indexSectionChanges('/repo', 'changes', {
      index: [],
      working: [{ uri: { fsPath: '/repo/a.txt' }, status: 5 }],
      merge: [],
      untracked: [
        { uri: { fsPath: '/repo/a.txt' }, status: 7 },
        { uri: { fsPath: '/repo/b.txt' }, status: 7 },
      ],
    })
    assert.equal(map.get('a.txt')?.status, 5)
    assert.equal(map.get('b.txt')?.status, 7)
    assert.equal(map.size, 2)
  })

  it('indexes staged paths separately from the working tree', () => {
    const map = indexSectionChanges('/repo', 'staged', {
      index: [{ uri: { fsPath: '/repo/a.txt' }, status: 0 }],
      working: [{ uri: { fsPath: '/repo/a.txt' }, status: 5 }],
      merge: [],
      untracked: [],
    })
    assert.equal(map.get('a.txt')?.status, 0)
    assert.equal(map.size, 1)
  })
})

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  buildRepositoryTree,
  commonPathPrefix,
  flattenRepositoryTree,
  formatRepoDescription,
  pruneUnchangedTree,
  sortTreeNodes,
  treeHasDirtyRepo,
  type RepoInput,
} from './tree'

const reposRoot = '/Volumes/Code/repos'

describe('commonPathPrefix', () => {
  it('finds shared prefix under repos root', () => {
    const p = commonPathPrefix([
      `${reposRoot}/meshenvy/envybot`,
      `${reposRoot}/meshenvy/lobbs`,
      `${reposRoot}/pocketbase/pockethost/pockethost`,
    ])
    assert.equal(p, reposRoot)
  })
})

describe('buildRepositoryTree', () => {
  it('strips shared prefix and nests meshenvy and pocketbase', () => {
    const tree = buildRepositoryTree([
      { rootPath: `${reposRoot}/meshenvy/envybot` },
      { rootPath: `${reposRoot}/meshenvy/lobbs` },
      { rootPath: `${reposRoot}/meshenvy/meshtastic/firmware` },
      { rootPath: `${reposRoot}/pocketbase/pockethost/pockethost` },
      { rootPath: `${reposRoot}/christensen` },
    ])

    const topNames = tree.map((n) => n.name)
    assert.ok(topNames.includes('meshenvy'))
    assert.ok(topNames.includes('pocketbase'))
    assert.ok(topNames.includes('christensen'))
    assert.ok(!topNames.includes('Volumes'))

    const meshenvy = tree.find((n) => n.kind === 'folder' && n.name === 'meshenvy')
    assert.ok(meshenvy && meshenvy.kind === 'folder')
    const meshChildNames = meshenvy.children.map((c) => c.name)
    assert.ok(meshChildNames.includes('envybot'))
    assert.ok(meshChildNames.includes('lobbs'))
    const fw = meshenvy.children.find((c) => c.kind === 'folder' && c.name === 'meshtastic')
    assert.ok(fw && fw.kind === 'folder')
    const firmware = fw.children.find((c) => c.kind === 'repo' && c.name === 'firmware')
    assert.ok(firmware && firmware.kind === 'repo')
    assert.equal(firmware.rootPath, `${reposRoot}/meshenvy/meshtastic/firmware`)
  })

  it('keeps duplicate basenames under different parents', () => {
    const tree = buildRepositoryTree([
      { rootPath: `${reposRoot}/meshenvy/meshtastic/firmware` },
      { rootPath: `${reposRoot}/pocketbase/meshtastic/firmware` },
    ])
    const meshenvy = tree.find((n) => n.kind === 'folder' && n.name === 'meshenvy')
    const pocketbase = tree.find((n) => n.kind === 'folder' && n.name === 'pocketbase')
    assert.ok(meshenvy && meshenvy.kind === 'folder')
    assert.ok(pocketbase && pocketbase.kind === 'folder')
    const a = meshenvy.children.find((c) => c.kind === 'folder' && c.name === 'meshtastic')
    const b = pocketbase.children.find((c) => c.kind === 'folder' && c.name === 'meshtastic')
    assert.ok(a && a.kind === 'folder' && a.children.some((c) => c.kind === 'repo'))
    assert.ok(b && b.kind === 'folder' && b.children.some((c) => c.kind === 'repo'))
  })

  it('merges a parent repo with nested checkouts under one folder', () => {
    const tree = buildRepositoryTree([
      { rootPath: `${reposRoot}/meshenvy/lobbs` },
      { rootPath: `${reposRoot}/meshenvy/lobbs/meshtastic` },
      { rootPath: `${reposRoot}/meshenvy/meshforge` },
      { rootPath: `${reposRoot}/christensen` },
    ])
    const meshenvy = tree.find((n) => n.kind === 'folder' && n.name === 'meshenvy')
    assert.ok(meshenvy && meshenvy.kind === 'folder')
    const lobbs = meshenvy.children.find((c) => c.kind === 'folder' && c.name === 'lobbs')
    assert.ok(lobbs && lobbs.kind === 'folder')
    assert.equal(lobbs.rootPath, `${reposRoot}/meshenvy/lobbs`)
    assert.equal(lobbs.children.length, 1)
    assert.equal(lobbs.children[0].kind, 'repo')
    assert.equal(lobbs.children[0].name, 'meshtastic')
    assert.ok(
      meshenvy.children.some(
        (c) => c.name === 'meshforge' && c.kind === 'repo' && c.rootPath.endsWith('/meshenvy/meshforge')
      )
    )
    assert.ok(!lobbs.children.some((c) => c.name === 'meshforge'))
  })

  it('places repo outside common prefix at top level', () => {
    const tree = buildRepositoryTree([
      { rootPath: `${reposRoot}/jeep` },
      { rootPath: '/tmp/other-checkout' },
    ])
    const names = tree.map((n) => n.name)
    assert.ok(names.includes('jeep'))
    assert.ok(names.includes('other-checkout'))
    const other = tree.find((n) => n.kind === 'repo' && n.name === 'other-checkout')
    assert.ok(other && other.kind === 'repo')
    assert.equal(other.rootPath, '/tmp/other-checkout')
  })
})

describe('pruneUnchangedTree', () => {
  it('keeps folder ancestors of dirty repos only', () => {
    const tree = buildRepositoryTree([
      { rootPath: `${reposRoot}/meshenvy/envybot` },
      { rootPath: `${reposRoot}/meshenvy/lobbs` },
      { rootPath: `${reposRoot}/christensen` },
    ])
    const dirty = new Set([`${reposRoot}/meshenvy/envybot`])
    const pruned = pruneUnchangedTree(tree, (p) => dirty.has(p))
    assert.equal(pruned.length, 1)
    assert.equal(pruned[0].kind, 'folder')
    assert.equal(pruned[0].name, 'meshenvy')
    assert.equal(pruned[0].children.length, 1)
    assert.equal(pruned[0].children[0].kind, 'repo')
    assert.equal(pruned[0].children[0].name, 'envybot')
  })
})

describe('treeHasDirtyRepo', () => {
  it('marks ancestor folders when a nested repo is dirty', () => {
    const tree = buildRepositoryTree([
      { rootPath: `${reposRoot}/meshenvy/lobbs` },
      { rootPath: `${reposRoot}/meshenvy/lobbs/meshtastic` },
      { rootPath: `${reposRoot}/christensen` },
    ])
    const meshenvy = tree.find((n) => n.kind === 'folder' && n.name === 'meshenvy')
    assert.ok(meshenvy && meshenvy.kind === 'folder')
    const lobbs = meshenvy.children.find((n) => n.kind === 'folder' && n.name === 'lobbs')
    assert.ok(lobbs && lobbs.kind === 'folder')
    const meshtastic = lobbs.children.find((n) => n.kind === 'repo' && n.name === 'meshtastic')
    assert.ok(meshtastic && meshtastic.kind === 'repo')
    const dirtyPath = `${reposRoot}/meshenvy/lobbs/meshtastic`
    const isDirty = (p: string) => p === dirtyPath
    assert.equal(treeHasDirtyRepo(meshtastic, isDirty), true)
    assert.equal(treeHasDirtyRepo(lobbs, isDirty), true)
    assert.equal(treeHasDirtyRepo(meshenvy, isDirty), true)
    const christensen = tree.find((n) => n.kind === 'repo' && n.name === 'christensen')
    assert.ok(christensen)
    assert.equal(treeHasDirtyRepo(christensen, isDirty), false)
  })
})

describe('flattenRepositoryTree', () => {
  it('collects all repo leaves', () => {
    const tree = buildRepositoryTree([
      { rootPath: `${reposRoot}/meshenvy/envybot` },
      { rootPath: `${reposRoot}/christensen` },
    ])
    const flat = flattenRepositoryTree(tree)
    assert.equal(flat.length, 2)
    assert.ok(flat.every((n) => n.kind === 'repo'))
  })
})

describe('sortTreeNodes', () => {
  it('sorts siblings by human case-insensitive name', () => {
    const tree: import('./tree').TreeNode[] = [
      { kind: 'repo', name: 'zebra', rootPath: '/z' },
      { kind: 'folder', name: 'Alpha', children: [] },
      { kind: 'repo', name: 'beta', rootPath: '/b' },
    ]
    sortTreeNodes(tree, 'name', () => 0)
    assert.deepEqual(
      tree.map((n) => n.name),
      ['Alpha', 'beta', 'zebra']
    )
  })

  it('sorts repos by recent wip rank at each level', () => {
    const tree = buildRepositoryTree([
      { rootPath: `${reposRoot}/meshenvy/lobbs` },
      { rootPath: `${reposRoot}/meshenvy/envybot` },
    ])
    const rank = (p: string) =>
      p.endsWith('envybot') ? 200 : p.endsWith('lobbs') ? 100 : 0
    sortTreeNodes(tree, 'wip', rank)
    assert.equal(tree.length, 2)
    assert.equal(tree[0].kind, 'repo')
    assert.equal(tree[0].name, 'envybot')
    assert.equal(tree[1].name, 'lobbs')
  })
})

describe('formatRepoDescription', () => {
  it('formats branch, dirty, detached, and ahead/behind', () => {
    assert.equal(
      formatRepoDescription({
        headName: 'main',
        indexChanges: 0,
        workingTreeChanges: 0,
        mergeChanges: 0,
      }),
      'main'
    )
    assert.equal(
      formatRepoDescription({
        headName: 'main',
        indexChanges: 1,
        workingTreeChanges: 0,
        mergeChanges: 0,
      }),
      'main*'
    )
    assert.equal(
      formatRepoDescription({
        headCommit: 'dcac7e56abcd',
        indexChanges: 0,
        workingTreeChanges: 0,
        mergeChanges: 0,
      }),
      'dcac7e5'
    )
    assert.equal(
      formatRepoDescription({
        headName: 'develop',
        indexChanges: 0,
        workingTreeChanges: 0,
        mergeChanges: 0,
        ahead: 2,
        behind: 1,
      }),
      'develop ↑2 ↓1'
    )
  })
})

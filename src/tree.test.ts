import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  buildRepositoryTree,
  commonPathPrefix,
  findAnchor,
  flattenRepositoryTree,
  formatRepoDescription,
  pruneUnchangedTree,
  sortTreeNodes,
  treeHasDirtyRepo,
  type WorkspaceAnchorInput,
} from './tree'

const reposRoot = '/Volumes/Code/repos'

function ws(pathSuffix: string, name?: string, order = 0): WorkspaceAnchorInput {
  const fsPath = pathSuffix.startsWith('/') ? pathSuffix : `${reposRoot}/${pathSuffix}`
  const base = pathSuffix.split('/').pop() ?? pathSuffix
  return { fsPath, name: name ?? base, order }
}

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

describe('findAnchor', () => {
  it('picks the longest matching workspace folder', () => {
    const folders = [
      ws('meshenvy/lobbs', 'lobbs', 0),
      ws('meshenvy/lobbs/meshtastic', 'meshtastic', 1),
    ]
    const anchor = findAnchor(`${reposRoot}/meshenvy/lobbs/meshtastic`, folders)
    assert.equal(anchor?.name, 'meshtastic')
  })
})

describe('buildRepositoryTree', () => {
  it('uses workspace folders at top level, not filesystem prefix groups', () => {
    const workspaceFolders: WorkspaceAnchorInput[] = [
      ws('meshenvy/envybot', 'envybot', 0),
      ws('meshenvy/enterprise', 'meshenvy-enterprise', 1),
      ws('christensen', 'christensen', 2),
    ]
    const tree = buildRepositoryTree(
      [
        { rootPath: `${reposRoot}/meshenvy/envybot` },
        { rootPath: `${reposRoot}/meshenvy/enterprise` },
        { rootPath: `${reposRoot}/christensen` },
      ],
      { workspaceFolders }
    )

    const topNames = tree.map((n) => n.name)
    assert.ok(topNames.includes('envybot'))
    assert.ok(topNames.includes('meshenvy-enterprise'))
    assert.ok(topNames.includes('christensen'))
    assert.ok(!topNames.includes('meshenvy'))
    assert.ok(!topNames.includes('Volumes'))

    assert.equal(tree.filter((n) => n.kind === 'repo').length, 3)
  })

  it('nests nested git repos under their workspace anchor', () => {
    const workspaceFolders: WorkspaceAnchorInput[] = [ws('meshenvy/lobbs', 'lobbs', 0)]
    const tree = buildRepositoryTree(
      [
        { rootPath: `${reposRoot}/meshenvy/lobbs` },
        { rootPath: `${reposRoot}/meshenvy/lobbs/meshtastic` },
        { rootPath: `${reposRoot}/meshenvy/meshforge` },
      ],
      {
        workspaceFolders: [
          ...workspaceFolders,
          ws('meshenvy/meshforge', 'meshforge', 1),
        ],
      }
    )

    const lobbs = tree.find((n) => n.name === 'lobbs')
    assert.ok(lobbs && lobbs.kind === 'folder')
    assert.equal(lobbs.rootPath, `${reposRoot}/meshenvy/lobbs`)
    assert.equal(lobbs.children.length, 1)
    assert.equal(lobbs.children[0].kind, 'repo')
    assert.equal(lobbs.children[0].name, 'meshtastic')

    const meshforge = tree.find((n) => n.name === 'meshforge')
    assert.ok(meshforge && meshforge.kind === 'repo')
  })

  it('omits git repos outside any workspace folder', () => {
    const tree = buildRepositoryTree(
      [
        { rootPath: `${reposRoot}/christensen` },
        { rootPath: '/tmp/other-checkout' },
      ],
      { workspaceFolders: [ws('christensen', 'christensen', 0)] }
    )
    assert.equal(tree.length, 1)
    assert.equal(tree[0].kind, 'repo')
    assert.equal(tree[0].name, 'christensen')
  })

  it('nests all repos under one anchor for a single workspace folder', () => {
    const monorepo = '/projects/monorepo'
    const workspaceFolders: WorkspaceAnchorInput[] = [
      { fsPath: monorepo, name: 'monorepo', order: 0 },
    ]
    const tree = buildRepositoryTree(
      [
        { rootPath: monorepo },
        { rootPath: `${monorepo}/pkg/a` },
      ],
      { workspaceFolders }
    )

    assert.equal(tree.length, 1)
    assert.equal(tree[0].kind, 'folder')
    assert.equal(tree[0].name, 'monorepo')
    assert.equal(tree[0].rootPath, monorepo)
    const pkg = tree[0].kind === 'folder' ? tree[0].children.find((c) => c.name === 'pkg') : undefined
    assert.ok(pkg && pkg.kind === 'folder')
    assert.ok(
      pkg.children.some((c) => c.kind === 'repo' && c.name === 'a' && c.rootPath === `${monorepo}/pkg/a`)
    )
  })

  it('falls back to flat basenames when no workspace folders are provided', () => {
    const tree = buildRepositoryTree([
      { rootPath: `${reposRoot}/jeep` },
      { rootPath: '/tmp/other-checkout' },
    ])
    assert.equal(tree.length, 2)
    assert.ok(tree.every((n) => n.kind === 'repo'))
  })
})

describe('pruneUnchangedTree', () => {
  it('keeps folder ancestors of dirty repos only', () => {
    const workspaceFolders: WorkspaceAnchorInput[] = [
      ws('meshenvy/envybot', 'envybot', 0),
      ws('meshenvy/lobbs', 'lobbs', 1),
    ]
    const tree = buildRepositoryTree(
      [
        { rootPath: `${reposRoot}/meshenvy/envybot` },
        { rootPath: `${reposRoot}/meshenvy/lobbs` },
      ],
      { workspaceFolders }
    )
    const dirty = new Set([`${reposRoot}/meshenvy/envybot`])
    const pruned = pruneUnchangedTree(tree, (p) => dirty.has(p))
    assert.equal(pruned.length, 1)
    assert.equal(pruned[0].kind, 'repo')
    assert.equal(pruned[0].name, 'envybot')
  })
})

describe('treeHasDirtyRepo', () => {
  it('marks ancestor folders when a nested repo is dirty', () => {
    const tree = buildRepositoryTree(
      [
        { rootPath: `${reposRoot}/meshenvy/lobbs` },
        { rootPath: `${reposRoot}/meshenvy/lobbs/meshtastic` },
      ],
      { workspaceFolders: [ws('meshenvy/lobbs', 'lobbs', 0)] }
    )
    const lobbs = tree.find((n) => n.name === 'lobbs')
    assert.ok(lobbs && lobbs.kind === 'folder')
    const meshtastic = lobbs.children.find((n) => n.kind === 'repo' && n.name === 'meshtastic')
    assert.ok(meshtastic && meshtastic.kind === 'repo')
    const dirtyPath = `${reposRoot}/meshenvy/lobbs/meshtastic`
    const isDirty = (p: string) => p === dirtyPath
    assert.equal(treeHasDirtyRepo(meshtastic, isDirty), true)
    assert.equal(treeHasDirtyRepo(lobbs, isDirty), true)
  })
})

describe('flattenRepositoryTree', () => {
  it('collects all repo leaves', () => {
    const tree = buildRepositoryTree(
      [
        { rootPath: `${reposRoot}/meshenvy/envybot` },
        { rootPath: `${reposRoot}/christensen` },
      ],
      {
        workspaceFolders: [
          ws('meshenvy/envybot', 'envybot', 0),
          ws('christensen', 'christensen', 1),
        ],
      }
    )
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
    const tree = buildRepositoryTree(
      [
        { rootPath: `${reposRoot}/meshenvy/lobbs` },
        { rootPath: `${reposRoot}/meshenvy/envybot` },
      ],
      {
        workspaceFolders: [
          ws('meshenvy/lobbs', 'lobbs', 0),
          ws('meshenvy/envybot', 'envybot', 1),
        ],
      }
    )
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

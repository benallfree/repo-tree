import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  buildRepositoryTree,
  commonPathPrefix,
  formatRepoDescription,
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

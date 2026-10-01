import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  CollapsibleCollapsed,
  CollapsibleExpanded,
  scmSectionExpandFallback,
  TreeExpansionSession,
} from './treeExpansion'

describe('scmSectionExpandFallback', () => {
  it('expands Changes and Staged by default', () => {
    assert.equal(scmSectionExpandFallback('changes'), CollapsibleExpanded)
    assert.equal(scmSectionExpandFallback('staged'), CollapsibleExpanded)
    assert.equal(scmSectionExpandFallback('merge'), CollapsibleCollapsed)
  })
})

describe('TreeExpansionSession', () => {
  it('remembers expanded and collapsed nodes by id', () => {
    const session = new TreeExpansionSession()
    session.recordExpanded('a', true)
    session.recordExpanded('b', false)
    assert.equal(session.collapsibleState('a', true), CollapsibleExpanded)
    assert.equal(session.collapsibleState('b', true), CollapsibleCollapsed)
  })

  it('tracks first repo open per session', () => {
    const session = new TreeExpansionSession()
    assert.equal(session.hasRepoOpenedInSession('/repo'), false)
    session.markRepoOpenedInSession('/repo')
    assert.equal(session.hasRepoOpenedInSession('/repo'), true)
  })

  it('copies path folder expansion from changes to staged when staging', () => {
    const session = new TreeExpansionSession()
    session.recordExpanded('/repo:changes:dir:samples', true)
    session.recordExpanded('/repo:changes:dir:other', false)
    session.copySectionExpansion('/repo', 'changes', 'staged', ['samples/a.txt', 'other/b.txt'])
    assert.equal(session.collapsibleState('/repo:staged:dir:samples', true), CollapsibleExpanded)
    assert.equal(session.collapsibleState('/repo:staged:dir:other', true), CollapsibleCollapsed)
    assert.equal(session.collapsibleState('/repo:staged:dir:missing', true), CollapsibleCollapsed)
  })
})

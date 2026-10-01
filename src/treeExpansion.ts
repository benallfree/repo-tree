/** vscode.TreeItemCollapsibleState values (no vscode import so node tests can load this file). */
export const CollapsibleNone = 0
export const CollapsibleCollapsed = 1
export const CollapsibleExpanded = 2

export type CollapsibleState = typeof CollapsibleNone | typeof CollapsibleCollapsed | typeof CollapsibleExpanded

import type { ScmSection } from './scmTree'
import { scmDirTreeId } from './repoTreeNode'

/** In-memory expand/collapse for Repository Tree (resets when the window reloads). */
export class TreeExpansionSession {
  private readonly expandedById = new Map<string, boolean>()
  private readonly reposOpenedInSession = new Set<string>()

  hasRepoOpenedInSession(repoRootPath: string): boolean {
    return this.reposOpenedInSession.has(repoRootPath)
  }

  markRepoOpenedInSession(repoRootPath: string): void {
    this.reposOpenedInSession.add(repoRootPath)
  }

  recordExpanded(treeId: string, expanded: boolean): void {
    this.expandedById.set(treeId, expanded)
  }

  collapsibleState(
    treeId: string,
    hasChildren: boolean,
    fallback: CollapsibleState = CollapsibleCollapsed
  ): CollapsibleState {
    if (!hasChildren) {
      return CollapsibleNone
    }
    if (this.expandedById.has(treeId)) {
      return this.expandedById.get(treeId) ? CollapsibleExpanded : CollapsibleCollapsed
    }
    return fallback
  }

  applyToItem(item: { treeId: string; collapsibleState: CollapsibleState }): void {
    if (item.collapsibleState === CollapsibleNone) {
      return
    }
    if (!this.expandedById.has(item.treeId)) {
      return
    }
    item.collapsibleState = this.expandedById.get(item.treeId)
      ? CollapsibleExpanded
      : CollapsibleCollapsed
  }

  markExpanded(treeId: string): void {
    this.expandedById.set(treeId, true)
  }

  /** Copy folder expand/collapse from one SCM section to another for staged paths. */
  copySectionExpansion(
    rootPath: string,
    fromSection: ScmSection,
    toSection: ScmSection,
    relativePaths: string[]
  ): void {
    for (const rel of relativePaths) {
      const parts = rel.split('/')
      if (parts.length <= 1) {
        continue
      }
      let built = ''
      for (let i = 0; i < parts.length - 1; i++) {
        built = built ? `${built}/${parts[i]}` : parts[i]
        const fromId = scmDirTreeId(rootPath, fromSection, built)
        const toId = scmDirTreeId(rootPath, toSection, built)
        if (this.expandedById.has(fromId)) {
          this.expandedById.set(toId, this.expandedById.get(fromId)!)
        }
      }
    }
  }
}

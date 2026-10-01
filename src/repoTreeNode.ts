import type { TreeNode } from './tree'
import { repoRootPath } from './tree'
import type { ScmSection } from './scmTree'

export type RepoTreeNode =
  | TreeNode
  | { kind: 'scmSection'; rootPath: string; section: ScmSection; name: string }
  | { kind: 'scmChangeDir'; rootPath: string; section: ScmSection; relativeDir: string; name: string }
  | {
      kind: 'scmFile'
      rootPath: string
      section: ScmSection
      relativePath: string
      name: string
    }

export function nodeRootPath(node: RepoTreeNode): string | undefined {
  if (node.kind === 'scmSection' || node.kind === 'scmChangeDir' || node.kind === 'scmFile') {
    return node.rootPath
  }
  return repoRootPath(node)
}

export function scmSectionTreeId(rootPath: string, section: ScmSection): string {
  return `${rootPath}:section:${section}`
}

export function scmDirTreeId(rootPath: string, section: ScmSection, relativeDir: string): string {
  return `${rootPath}:${section}:dir:${relativeDir || '.'}`
}

export function stableNodeId(node: RepoTreeNode, parentId?: string): string {
  if (node.kind === 'repo') {
    return node.rootPath
  }
  if (node.kind === 'folder') {
    if (node.rootPath) {
      return node.rootPath
    }
    const base = parentId ?? 'root'
    return `${base}/folder:${node.name}`
  }
  if (node.kind === 'scmSection') {
    return `${node.rootPath}:section:${node.section}`
  }
  if (node.kind === 'scmChangeDir') {
    return `${node.rootPath}:${node.section}:dir:${node.relativeDir || '.'}`
  }
  return `${node.rootPath}:${node.section}:file:${node.relativePath}`
}

import type { TreeNode } from './tree'
import { repoRootPath } from './tree'

export type FileChangeState = 'staged' | 'changes' | 'merge'

export type ScmSection = 'staged' | 'changes' | 'merge'

export type RepoTreeNode =
  | TreeNode
  | { kind: 'scmChangeDir'; rootPath: string; relativeDir: string; name: string }
  | {
      kind: 'scmFile'
      rootPath: string
      section: ScmSection
      relativePath: string
      name: string
      states: FileChangeState[]
    }

export function nodeRootPath(node: RepoTreeNode): string | undefined {
  if (node.kind === 'scmChangeDir' || node.kind === 'scmFile') {
    return node.rootPath
  }
  return repoRootPath(node)
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
  if (node.kind === 'scmChangeDir') {
    return `${node.rootPath}:dir:${node.relativeDir || '.'}`
  }
  return `${node.rootPath}:file:${node.relativePath}`
}

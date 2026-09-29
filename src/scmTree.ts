import * as path from 'path'
import type { FileChangeState } from './repoTreeNode'

export interface GitChangeLike {
  uri: { fsPath: string }
}

export interface MergedChangeFile {
  relativePath: string
  name: string
  states: FileChangeState[]
}

export type NestedChangeNode =
  | { kind: 'dir'; relativeDir: string; name: string; children: NestedChangeNode[] }
  | { kind: 'file'; relativePath: string; name: string; states: FileChangeState[] }

export function relativeRepoPath(repoRoot: string, filePath: string): string {
  const rel = path.relative(repoRoot, filePath)
  if (!rel || rel.startsWith('..')) {
    return filePath
  }
  return rel.split(path.sep).join('/')
}

export function pathsFromChanges(repoRoot: string, changes: readonly GitChangeLike[]): string[] {
  return changes.map((c) => relativeRepoPath(repoRoot, c.uri.fsPath))
}

function addState(map: Map<string, Set<FileChangeState>>, relativePath: string, state: FileChangeState): void {
  let set = map.get(relativePath)
  if (!set) {
    set = new Set()
    map.set(relativePath, set)
  }
  set.add(state)
}

export function mergeRepoChanges(
  repoRoot: string,
  indexChanges: readonly GitChangeLike[],
  workingTreeChanges: readonly GitChangeLike[],
  mergeChanges: readonly GitChangeLike[]
): MergedChangeFile[] {
  const map = new Map<string, Set<FileChangeState>>()
  for (const c of indexChanges) {
    addState(map, relativeRepoPath(repoRoot, c.uri.fsPath), 'staged')
  }
  for (const c of workingTreeChanges) {
    addState(map, relativeRepoPath(repoRoot, c.uri.fsPath), 'changes')
  }
  for (const c of mergeChanges) {
    addState(map, relativeRepoPath(repoRoot, c.uri.fsPath), 'merge')
  }
  return [...map.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([relativePath, states]) => ({
      relativePath,
      name: path.basename(relativePath),
      states: [...states],
    }))
}

function insertIntoTree(root: NestedChangeNode[], file: MergedChangeFile): void {
  const parts = file.relativePath.split('/')
  if (parts.length === 1) {
    root.push({ kind: 'file', relativePath: file.relativePath, name: file.name, states: file.states })
    return
  }
  const dirParts = parts.slice(0, -1)
  let level = root
  let built = ''
  for (const segment of dirParts) {
    built = built ? `${built}/${segment}` : segment
    let dir = level.find(
      (n): n is Extract<NestedChangeNode, { kind: 'dir' }> => n.kind === 'dir' && n.relativeDir === built
    )
    if (!dir) {
      dir = { kind: 'dir', relativeDir: built, name: segment, children: [] }
      level.push(dir)
    }
    level = dir.children
  }
  level.push({
    kind: 'file',
    relativePath: file.relativePath,
    name: file.name,
    states: file.states,
  })
}

function sortNested(nodes: NestedChangeNode[]): void {
  nodes.sort((a, b) => {
    if (a.kind !== b.kind) {
      return a.kind === 'dir' ? -1 : 1
    }
    const keyA = a.kind === 'dir' ? a.relativeDir : a.relativePath
    const keyB = b.kind === 'dir' ? b.relativeDir : b.relativePath
    return keyA.localeCompare(keyB)
  })
  for (const node of nodes) {
    if (node.kind === 'dir') {
      sortNested(node.children)
    }
  }
}

export function nestChangePaths(files: MergedChangeFile[], flat: boolean): NestedChangeNode[] {
  if (files.length === 0) {
    return []
  }
  if (flat) {
    return files.map((f) => ({
      kind: 'file' as const,
      relativePath: f.relativePath,
      name: f.name,
      states: f.states,
    }))
  }
  const root: NestedChangeNode[] = []
  for (const file of files) {
    insertIntoTree(root, file)
  }
  sortNested(root)
  return root
}

export function childrenOfChangeDir(
  nodes: NestedChangeNode[],
  relativeDir: string
): NestedChangeNode[] {
  if (!relativeDir) {
    return nodes
  }
  const walk = (list: NestedChangeNode[]): NestedChangeNode[] | undefined => {
    for (const n of list) {
      if (n.kind === 'dir' && n.relativeDir === relativeDir) {
        return n.children
      }
      if (n.kind === 'dir') {
        const found = walk(n.children)
        if (found !== undefined) {
          return found
        }
      }
    }
    return undefined
  }
  return walk(nodes) ?? []
}

export function stateDescription(states: FileChangeState[]): string {
  const hasStaged = states.includes('staged')
  const hasChanges = states.includes('changes')
  const hasMerge = states.includes('merge')
  const parts: string[] = []
  if (hasStaged && hasChanges) {
    parts.push('staged, unstaged')
  } else if (hasStaged) {
    parts.push('staged')
  } else if (hasChanges) {
    parts.push('unstaged')
  }
  if (hasMerge) {
    parts.push('merge')
  }
  return parts.join(', ')
}

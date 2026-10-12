import * as path from 'path'
import { compareHumanNames } from './tree'

export type FileChangeState = 'staged' | 'changes' | 'merge'

export type ScmSection = 'staged' | 'changes' | 'merge'

export function fileStateForSection(section: ScmSection): FileChangeState {
  return section
}

export const SCM_SECTION_LABELS: Record<ScmSection, string> = {
  staged: 'Staged Changes',
  changes: 'Changes',
  merge: 'Merge Changes',
}

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

export function filesForSection(merged: MergedChangeFile[], section: ScmSection): MergedChangeFile[] {
  const key: FileChangeState =
    section === 'staged' ? 'staged' : section === 'merge' ? 'merge' : 'changes'
  return merged.filter((f) => f.states.includes(key))
}

export function repoSectionHasFiles(
  merged: MergedChangeFile[],
  section: ScmSection
): boolean {
  return filesForSection(merged, section).length > 0
}

export const SCM_SECTION_ORDER: ScmSection[] = ['staged', 'changes', 'merge']

/** Which SCM resource group to use for diff/decoration when a path has multiple states. */
export function pathUnderRelativeDir(relativePath: string, relativeDir: string): boolean {
  if (!relativeDir) {
    return true
  }
  if (relativePath === relativeDir) {
    return true
  }
  return relativePath.startsWith(`${relativeDir}/`)
}

export function pathsInSectionUnderDir(
  merged: MergedChangeFile[],
  section: ScmSection,
  relativeDir: string
): string[] {
  return filesForSection(merged, section)
    .filter((f) => pathUnderRelativeDir(f.relativePath, relativeDir))
    .map((f) => f.relativePath)
}

export function pathsUnderDir(merged: MergedChangeFile[], relativeDir: string): string[] {
  return merged
    .filter((f) => pathUnderRelativeDir(f.relativePath, relativeDir))
    .map((f) => f.relativePath)
}

export function primaryScmSection(states: FileChangeState[]): ScmSection {
  if (states.includes('merge')) {
    return 'merge'
  }
  if (states.includes('changes')) {
    return 'changes'
  }
  if (states.includes('staged')) {
    return 'staged'
  }
  return 'changes'
}

export function mergeRepoChanges(
  repoRoot: string,
  indexChanges: readonly GitChangeLike[],
  workingTreeChanges: readonly GitChangeLike[],
  mergeChanges: readonly GitChangeLike[],
  untrackedChanges: readonly GitChangeLike[] = []
): MergedChangeFile[] {
  const map = new Map<string, Set<FileChangeState>>()
  for (const c of indexChanges) {
    addState(map, relativeRepoPath(repoRoot, c.uri.fsPath), 'staged')
  }
  for (const c of workingTreeChanges) {
    addState(map, relativeRepoPath(repoRoot, c.uri.fsPath), 'changes')
  }
  for (const c of untrackedChanges) {
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

function insertIntoTree(
  root: NestedChangeNode[],
  file: MergedChangeFile,
  dirs: Map<string, Extract<NestedChangeNode, { kind: 'dir' }>>
): void {
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
    let dir = dirs.get(built)
    if (!dir) {
      dir = { kind: 'dir', relativeDir: built, name: segment, children: [] }
      dirs.set(built, dir)
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
    return compareHumanNames(a.name, b.name)
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
    return files
      .map((f) => ({
        kind: 'file' as const,
        relativePath: f.relativePath,
        name: f.name,
        states: f.states,
      }))
      .sort((a, b) => compareHumanNames(a.name, b.name))
  }
  const root: NestedChangeNode[] = []
  const dirs = new Map<string, Extract<NestedChangeNode, { kind: 'dir' }>>()
  for (const file of files) {
    insertIntoTree(root, file, dirs)
  }
  sortNested(root)
  return root
}

/** Order-sensitive fingerprint of a path list. Used to reuse a nested change tree. */
export function pathListSignature(paths: readonly string[]): string {
  let h = 2166136261
  let chars = 0
  for (const s of paths) {
    chars += s.length
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i)
      h = Math.imul(h, 16777619)
    }
    h ^= 0xff
  }
  const first = paths.length > 0 ? paths[0] : ''
  const last = paths.length > 0 ? paths[paths.length - 1] : ''
  return `${paths.length}:${chars}:${h >>> 0}:${first}:${last}`
}

/** Working-tree entries overwrite untracked entries for the same path. */
export function indexSectionChanges<T extends GitChangeLike>(
  repoRoot: string,
  section: ScmSection,
  groups: {
    index: readonly T[]
    working: readonly T[]
    merge: readonly T[]
    untracked: readonly T[]
  }
): Map<string, T> {
  const map = new Map<string, T>()
  const put = (change: T) => {
    map.set(relativeRepoPath(repoRoot, change.uri.fsPath), change)
  }
  if (section === 'staged') {
    for (const change of groups.index) put(change)
  } else if (section === 'merge') {
    for (const change of groups.merge) put(change)
  } else {
    for (const change of groups.untracked) put(change)
    for (const change of groups.working) put(change)
  }
  return map
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

/** relativeDir → direct children. Empty string is the section root. */
export function nestedDirChildren(nodes: NestedChangeNode[]): Map<string, NestedChangeNode[]> {
  const map = new Map<string, NestedChangeNode[]>()
  map.set('', nodes)
  const walk = (list: NestedChangeNode[]): void => {
    for (const n of list) {
      if (n.kind === 'dir') {
        map.set(n.relativeDir, n.children)
        walk(n.children)
      }
    }
  }
  walk(nodes)
  return map
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

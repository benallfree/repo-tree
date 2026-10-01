import * as path from 'path'

export interface RepoInput {
  rootPath: string
}

export interface WorkspaceAnchorInput {
  fsPath: string
  name: string
  order: number
}

export interface BuildRepositoryTreeOptions {
  workspaceFolders?: WorkspaceAnchorInput[]
}

export interface RepoStatusInput {
  headName?: string
  headCommit?: string
  indexChanges: number
  workingTreeChanges: number
  mergeChanges: number
  ahead?: number
  behind?: number
}

export type TreeNode =
  | { kind: 'folder'; name: string; children: TreeNode[]; rootPath?: string }
  | { kind: 'repo'; name: string; rootPath: string }

export type SortMode = 'name' | 'wip'

export function repoRootPath(node: TreeNode): string | undefined {
  if (node.kind === 'repo') {
    return node.rootPath
  }
  return node.rootPath
}

function normalizeRoot(p: string): string {
  return path.normalize(p.replace(/\/+$/, ''))
}

function splitSegments(p: string): string[] {
  const normalized = normalizeRoot(p)
  const rel = path.relative(path.parse(normalized).root, normalized)
  if (!rel || rel === '.') return []
  return rel.split(path.sep).filter(Boolean)
}

export function commonPathPrefix(paths: string[]): string {
  if (paths.length === 0) return ''
  const normalized = paths.map(normalizeRoot)
  let prefix = normalized[0]
  for (let i = 1; i < normalized.length; i++) {
    const p = normalized[i]
    while (p !== prefix && !p.startsWith(prefix + path.sep) && !prefix.startsWith(p + path.sep)) {
      const parent = path.dirname(prefix)
      if (parent === prefix) {
        prefix = ''
        break
      }
      prefix = parent
    }
    if (prefix === '') break
  }
  return prefix
}

function findFolder(nodes: TreeNode[], name: string): Extract<TreeNode, { kind: 'folder' }> | undefined {
  const folder = nodes.find((n) => n.kind === 'folder' && n.name === name)
  return folder?.kind === 'folder' ? folder : undefined
}

function promoteRepoToFolder(
  root: TreeNode[],
  name: string
): Extract<TreeNode, { kind: 'folder' }> {
  const index = root.findIndex((n) => n.kind === 'repo' && n.name === name)
  if (index >= 0) {
    const repo = root[index] as Extract<TreeNode, { kind: 'repo' }>
    const folder: Extract<TreeNode, { kind: 'folder' }> = {
      kind: 'folder',
      name,
      children: [],
      rootPath: repo.rootPath,
    }
    root.splice(index, 1, folder)
    return folder
  }
  const folder: Extract<TreeNode, { kind: 'folder' }> = { kind: 'folder', name, children: [] }
  root.push(folder)
  return folder
}

function insertRepo(root: TreeNode[], segments: string[], rootPath: string): void {
  if (segments.length === 0) {
    return
  }
  if (segments.length === 1) {
    const name = segments[0]
    const existingFolder = findFolder(root, name)
    if (existingFolder) {
      existingFolder.rootPath = rootPath
      return
    }
    root.push({ kind: 'repo', name, rootPath })
    return
  }
  const [head, ...rest] = segments
  let folder = findFolder(root, head)
  if (!folder) {
    folder = promoteRepoToFolder(root, head)
  }
  insertRepo(folder.children, rest, rootPath)
}

export function repoHasWorkingChanges(status: RepoStatusInput): boolean {
  return status.indexChanges + status.workingTreeChanges + status.mergeChanges > 0
}

/** True when this node’s repo (if any) or any nested repo has local changes. */
export function treeHasDirtyRepo(
  node: TreeNode,
  isDirty: (rootPath: string) => boolean
): boolean {
  const own = repoRootPath(node)
  if (own && isDirty(own)) {
    return true
  }
  if (node.kind === 'folder') {
    return node.children.some((child) => treeHasDirtyRepo(child, isDirty))
  }
  return false
}

/** Case-insensitive, numeric-aware sibling sort (e.g. item2 before item10). */
export function compareHumanNames(a: string, b: string): number {
  return a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true })
}

function compareNodes(
  a: TreeNode,
  b: TreeNode,
  sortMode: SortMode,
  wipRank: (rootPath: string) => number
): number {
  if (sortMode === 'name') {
    return compareHumanNames(a.name, b.name)
  }

  const aFolder = a.kind === 'folder'
  const bFolder = b.kind === 'folder'
  if (aFolder !== bFolder) {
    return aFolder ? -1 : 1
  }
  const aPath = repoRootPath(a)
  const bPath = repoRootPath(b)
  if (aPath && bPath) {
    const byWip = wipRank(bPath) - wipRank(aPath)
    if (byWip !== 0) {
      return byWip
    }
  }
  return compareHumanNames(a.name, b.name)
}

export function sortTreeNodes(
  nodes: TreeNode[],
  sortMode: SortMode,
  wipRank: (rootPath: string) => number
): void {
  nodes.sort((a, b) => compareNodes(a, b, sortMode, wipRank))
  for (const node of nodes) {
    if (node.kind === 'folder') {
      sortTreeNodes(node.children, sortMode, wipRank)
    }
  }
}

export function flattenRepositoryTree(nodes: TreeNode[]): TreeNode[] {
  const repos: Extract<TreeNode, { kind: 'repo' }>[] = []
  const walk = (list: TreeNode[]): void => {
    for (const node of list) {
      if (node.kind === 'repo') {
        repos.push(node)
      } else {
        if (node.rootPath) {
          repos.push({ kind: 'repo', name: node.name, rootPath: node.rootPath })
        }
        walk(node.children)
      }
    }
  }
  walk(nodes)
  return repos
}

export function pruneUnchangedTree(
  nodes: TreeNode[],
  isDirty: (rootPath: string) => boolean
): TreeNode[] {
  const out: TreeNode[] = []
  for (const node of nodes) {
    if (node.kind === 'repo') {
      if (isDirty(node.rootPath)) {
        out.push(node)
      }
      continue
    }
    const keepFolder = node.rootPath ? isDirty(node.rootPath) : false
    const children = pruneUnchangedTree(node.children, isDirty)
    if (children.length > 0 || keepFolder) {
      out.push({ kind: 'folder', name: node.name, children, rootPath: node.rootPath })
    }
  }
  return out
}

export function findAnchor(
  repoPath: string,
  folders: WorkspaceAnchorInput[]
): WorkspaceAnchorInput | undefined {
  const normalized = normalizeRoot(repoPath)
  let best: WorkspaceAnchorInput | undefined
  let bestLen = -1
  for (const folder of folders) {
    const anchorPath = normalizeRoot(folder.fsPath)
    if (normalized === anchorPath || normalized.startsWith(anchorPath + path.sep)) {
      if (anchorPath.length > bestLen) {
        bestLen = anchorPath.length
        best = folder
      }
    }
  }
  return best
}

function relativeSegmentsFromAnchor(anchorPath: string, repoPath: string): string[] {
  const rel = path.relative(normalizeRoot(anchorPath), normalizeRoot(repoPath))
  if (!rel || rel === '.') {
    return []
  }
  return rel.split(path.sep).filter(Boolean)
}

function buildBucketNode(displayName: string, anchorPath: string, repoPaths: string[]): TreeNode {
  const anchor = normalizeRoot(anchorPath)
  const paths = repoPaths.map(normalizeRoot)

  if (paths.length === 1 && paths[0] === anchor) {
    return { kind: 'repo', name: displayName, rootPath: anchor }
  }

  const nested = paths.filter((p) => p !== anchor)
  const children: TreeNode[] = []
  for (const p of nested) {
    insertRepo(children, relativeSegmentsFromAnchor(anchor, p), p)
  }

  if (paths.some((p) => p === anchor)) {
    return { kind: 'folder', name: displayName, rootPath: anchor, children }
  }

  return { kind: 'folder', name: displayName, children }
}

function reposUnderWorkspace(
  repoPaths: string[],
  folders: WorkspaceAnchorInput[]
): string[] {
  const out: string[] = []
  for (const p of repoPaths) {
    if (findAnchor(p, folders)) {
      out.push(p)
    }
  }
  return out
}

export function buildRepositoryTree(
  repos: RepoInput[],
  options?: BuildRepositoryTreeOptions
): TreeNode[] {
  if (repos.length === 0) {
    return []
  }

  const normalized = repos.map((r) => normalizeRoot(r.rootPath))
  const folders = options?.workspaceFolders ?? []

  if (folders.length === 0) {
    return normalized.map((rootPath) => ({
      kind: 'repo' as const,
      name: path.basename(rootPath),
      rootPath,
    }))
  }

  if (folders.length === 1) {
    const anchor = folders[0]
    const under = reposUnderWorkspace(normalized, folders)
    const node = buildBucketNode(anchor.name, anchor.fsPath, under)
    return under.length > 0 ? [node] : []
  }

  const buckets = new Map<string, { anchor: WorkspaceAnchorInput; paths: string[] }>()
  for (const rootPath of normalized) {
    const match = findAnchor(rootPath, folders)
    if (!match) {
      continue
    }
    const key = normalizeRoot(match.fsPath)
    let bucket = buckets.get(key)
    if (!bucket) {
      bucket = { anchor: match, paths: [] }
      buckets.set(key, bucket)
    }
    bucket.paths.push(rootPath)
  }

  const root: TreeNode[] = []
  const sortedAnchors = [...folders].sort((a, b) => a.order - b.order)
  for (const folder of sortedAnchors) {
    const key = normalizeRoot(folder.fsPath)
    const bucket = buckets.get(key)
    if (!bucket || bucket.paths.length === 0) {
      continue
    }
    root.push(buildBucketNode(folder.name, folder.fsPath, bucket.paths))
  }
  return root
}

export function formatRepoDescription(status: RepoStatusInput): string {
  let label: string
  if (status.headName) {
    label = status.headName
  } else if (status.headCommit) {
    label = status.headCommit.slice(0, 7)
  } else {
    label = 'unknown'
  }

  const dirty =
    status.indexChanges + status.workingTreeChanges + status.mergeChanges > 0
  if (dirty) {
    label += '*'
  }

  const parts: string[] = []
  if (status.ahead !== undefined && status.ahead > 0) {
    parts.push(`↑${status.ahead}`)
  }
  if (status.behind !== undefined && status.behind > 0) {
    parts.push(`↓${status.behind}`)
  }
  if (parts.length > 0) {
    label += ` ${parts.join(' ')}`
  }

  return label
}

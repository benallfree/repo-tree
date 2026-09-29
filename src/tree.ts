import * as path from 'path'

export interface RepoInput {
  rootPath: string
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
  | { kind: 'folder'; name: string; children: TreeNode[] }
  | { kind: 'repo'; name: string; rootPath: string }

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

function insertRepo(root: TreeNode[], segments: string[], rootPath: string): void {
  if (segments.length === 0) {
    return
  }
  if (segments.length === 1) {
    root.push({ kind: 'repo', name: segments[0], rootPath })
    sortTreeLevel(root)
    return
  }
  const [head, ...rest] = segments
  let folder = root.find((n) => n.kind === 'folder' && n.name === head) as
    | Extract<TreeNode, { kind: 'folder' }>
    | undefined
  if (!folder) {
    folder = { kind: 'folder', name: head, children: [] }
    root.push(folder)
  }
  insertRepo(folder.children, rest, rootPath)
  sortTreeLevel(root)
}

function sortTreeLevel(nodes: TreeNode[]): void {
  nodes.sort((a, b) => {
    if (a.kind !== b.kind) {
      return a.kind === 'folder' ? -1 : 1
    }
    return a.name.localeCompare(b.name)
  })
  for (const node of nodes) {
    if (node.kind === 'folder') {
      sortTreeLevel(node.children)
    }
  }
}

export function buildRepositoryTree(repos: RepoInput[]): TreeNode[] {
  if (repos.length === 0) return []
  const normalized = repos.map((r) => normalizeRoot(r.rootPath))
  const prefix = commonPathPrefix(normalized)
  const root: TreeNode[] = []
  if (!prefix) {
    for (const rootPath of normalized) {
      root.push({ kind: 'repo', name: path.basename(rootPath), rootPath })
    }
    sortTreeLevel(root)
    return root
  }
  const prefixSegs = splitSegments(prefix)
  for (const rootPath of normalized) {
    const segs = splitSegments(rootPath)
    const relative = segs.slice(prefixSegs.length)
    if (relative.length === 0) {
      root.push({ kind: 'repo', name: path.basename(rootPath), rootPath })
    } else {
      insertRepo(root, relative, rootPath)
    }
  }
  sortTreeLevel(root)
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

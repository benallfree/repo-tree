import * as path from 'path'
import * as vscode from 'vscode'
import type { RepoTreeNode } from './repoTreeNode'
import { nodeRootPath } from './repoTreeNode'
import {
  mergeRepoChanges,
  pathsUnderDir,
  primaryScmSection,
  relativeRepoPath,
  type FileChangeState,
  type MergedChangeFile,
  type ScmSection,
} from './scmTree'

export interface GitChange {
  uri: vscode.Uri
  originalUri?: vscode.Uri
}

export interface GitRepositoryState {
  indexChanges: readonly GitChange[]
  workingTreeChanges: readonly GitChange[]
  mergeChanges: readonly GitChange[]
}

export interface GitScmResource {
  resourceUri: vscode.Uri
  openChange(): Promise<void>
  openFile(): Promise<void>
  letter?: string
  strikeThrough?: boolean
  tooltip?: string
}

export interface GitScmResourceGroup {
  resourceStates: GitScmResource[]
}

export interface GitRepositoryRef {
  rootUri: vscode.Uri
  state: GitRepositoryState
  inputBox?: { value: string }
  indexGroup?: GitScmResourceGroup
  workingTreeGroup?: GitScmResourceGroup
  mergeGroup?: GitScmResourceGroup
  untrackedGroup?: GitScmResourceGroup
  add(paths: string[]): Promise<void>
  revert(paths: string[]): Promise<void>
  clean(paths: string[]): Promise<void>
  commit(message: string): Promise<void>
}

export interface GitApiLite {
  repositories: GitRepositoryRef[]
}

export interface RepoTreeItemLike {
  readonly node: RepoTreeNode
}

function pathsEqual(a: string, b: string): boolean {
  return path.normalize(a) === path.normalize(b)
}

export function rootPathFromArg(item?: RepoTreeItemLike, rootPath?: string): string | undefined {
  if (rootPath) {
    return rootPath
  }
  if (item) {
    return nodeRootPath(item.node)
  }
  return undefined
}

export function findGitRepository(
  git: GitApiLite | undefined,
  rootPath: string
): GitRepositoryRef | undefined {
  if (!git) {
    return undefined
  }
  return git.repositories.find((r) => pathsEqual(r.rootUri.fsPath, rootPath))
}

function absPathForRelative(rootPath: string, relativePath: string): string {
  return path.join(rootPath, ...relativePath.split('/'))
}

export function findScmResource(
  repo: GitRepositoryRef,
  relativePath: string,
  section: ScmSection
): GitScmResource | undefined {
  const target = absPathForRelative(repo.rootUri.fsPath, relativePath)
  const match = (r: GitScmResource) => pathsEqual(r.resourceUri.fsPath, target)

  if (section === 'staged') {
    return repo.indexGroup?.resourceStates.find(match)
  }
  if (section === 'merge') {
    return repo.mergeGroup?.resourceStates.find(match)
  }
  return (
    repo.workingTreeGroup?.resourceStates.find(match) ??
    repo.untrackedGroup?.resourceStates.find(match)
  )
}

export function findScmResourceForFile(
  repo: GitRepositoryRef,
  relativePath: string,
  states: FileChangeState[]
): GitScmResource | undefined {
  return findScmResource(repo, relativePath, primaryScmSection(states))
}

export async function runGitRepoCommand(
  getGit: () => GitApiLite | undefined,
  gitCommand: string,
  item?: RepoTreeItemLike,
  rootPath?: string
): Promise<void> {
  const resolved = rootPathFromArg(item, rootPath)
  if (!resolved) {
    return
  }
  const repo = findGitRepository(getGit(), resolved)
  if (!repo) {
    return
  }
  await vscode.commands.executeCommand(gitCommand, repo)
}

function relativePathSet(paths: string[]): Set<string> {
  return new Set(paths.map((p) => p.split(path.sep).join('/')))
}

function indexPathsForRelative(
  repo: GitRepositoryRef,
  relativePaths: string[]
): string[] {
  const want = relativePathSet(relativePaths)
  return repo.state.indexChanges
    .filter((c) => want.has(relativeRepoPath(repo.rootUri.fsPath, c.uri.fsPath)))
    .map((c) => c.uri.fsPath)
}

function fsPathsToClean(repo: GitRepositoryRef, relativePaths: string[]): string[] {
  const want = relativePathSet(relativePaths)
  const root = repo.rootUri.fsPath
  const out = new Set<string>()
  for (const rel of relativePaths) {
    out.add(absPathForRelative(root, rel))
  }
  for (const c of repo.state.workingTreeChanges) {
    const rel = relativeRepoPath(root, c.uri.fsPath)
    if (want.has(rel)) {
      out.add(c.uri.fsPath)
    }
  }
  for (const c of repo.state.mergeChanges) {
    const rel = relativeRepoPath(root, c.uri.fsPath)
    if (want.has(rel)) {
      out.add(c.uri.fsPath)
    }
  }
  for (const r of repo.untrackedGroup?.resourceStates ?? []) {
    const rel = relativeRepoPath(root, r.resourceUri.fsPath)
    if (want.has(rel)) {
      out.add(r.resourceUri.fsPath)
    }
  }
  return [...out]
}

function mergedForRepo(git: GitApiLite | undefined, rootPath: string): MergedChangeFile[] {
  const repo = findGitRepository(git, rootPath)
  if (!repo) {
    return []
  }
  return mergeRepoChanges(
    repo.rootUri.fsPath,
    repo.state.indexChanges,
    repo.state.workingTreeChanges,
    repo.state.mergeChanges
  )
}

export async function revertPaths(
  getGit: () => GitApiLite | undefined,
  rootPath: string,
  paths: string[]
): Promise<void> {
  const repo = findGitRepository(getGit(), rootPath)
  if (!repo || paths.length === 0) {
    return
  }
  const label = paths.length === 1 ? paths[0] : `${paths.length} files`
  const ok = await vscode.window.showWarningMessage(
    `Revert changes in ${label}?`,
    { modal: true },
    'Revert'
  )
  if (ok !== 'Revert') {
    return
  }

  const indexed = indexPathsForRelative(repo, paths)
  if (indexed.length > 0) {
    await repo.revert(indexed)
  }

  const toClean = fsPathsToClean(repo, paths)
  if (toClean.length > 0) {
    await repo.clean(toClean)
  }
}

export async function revertFolder(
  getGit: () => GitApiLite | undefined,
  rootPath: string,
  relativeDir: string
): Promise<void> {
  const paths = pathsUnderDir(mergedForRepo(getGit(), rootPath), relativeDir)
  await revertPaths(getGit, rootPath, paths)
}

export async function openChangeDiff(
  getGit: () => GitApiLite | undefined,
  item?: RepoTreeItemLike
): Promise<void> {
  if (item?.node.kind !== 'scmFile') {
    return
  }
  const { rootPath, relativePath, states } = item.node
  const repo = findGitRepository(getGit(), rootPath)
  if (!repo) {
    return
  }

  const resource = findScmResourceForFile(repo, relativePath, states)
  if (resource) {
    await resource.openChange()
    return
  }

  const uri = vscode.Uri.file(absPathForRelative(rootPath, relativePath))
  await vscode.commands.executeCommand('git.openChange', uri)
}

export async function openChangeFile(
  _getGit: () => GitApiLite | undefined,
  item?: RepoTreeItemLike
): Promise<void> {
  if (item?.node.kind !== 'scmFile') {
    return
  }
  const { rootPath, relativePath } = item.node
  const uri = vscode.Uri.file(absPathForRelative(rootPath, relativePath))
  try {
    const doc = await vscode.workspace.openTextDocument(uri)
    await vscode.window.showTextDocument(doc, { preview: false })
  } catch {
    void vscode.window.showErrorMessage(`Could not open ${relativePath}`)
  }
}

export const SCM_FILE_CONTEXT = 'repoTree.scmFile'
export const SCM_CHANGE_DIR_CONTEXT = 'repoTree.scmChangeDir'

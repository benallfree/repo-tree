import * as path from 'path'
import * as vscode from 'vscode'
import type { RepoTreeNode } from './repoTreeNode'
import { nodeRootPath } from './repoTreeNode'
import {
  mergeRepoChanges,
  pathsInSectionUnderDir,
  relativeRepoPath,
  type MergedChangeFile,
  type ScmSection,
} from './scmTree'
import type { GitStatusValue } from './gitStatus'

export interface GitChange {
  uri: vscode.Uri
  originalUri?: vscode.Uri
  renameUri?: vscode.Uri
  status?: GitStatusValue
}

export interface GitRepositoryState {
  indexChanges: readonly GitChange[]
  workingTreeChanges: readonly GitChange[]
  mergeChanges: readonly GitChange[]
  untrackedChanges?: readonly GitChange[]
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

export interface GitCommitOptions {
  all?: boolean | 'tracked'
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
  commit(message: string, opts?: GitCommitOptions): Promise<void>
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

function absPathsForRelative(rootPath: string, relativePaths: string[]): string[] {
  return relativePaths.map((p) => absPathForRelative(rootPath, p))
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
  section: ScmSection
): GitScmResource | undefined {
  return findScmResource(repo, relativePath, section)
}

export function findChangeForSection(
  repo: GitRepositoryRef,
  relativePath: string,
  section: ScmSection
): GitChange | undefined {
  const root = repo.rootUri.fsPath
  const want = relativePath.split('/').join('/')
  const match = (c: GitChange) => relativeRepoPath(root, c.uri.fsPath) === want

  if (section === 'staged') {
    return repo.state.indexChanges.find(match)
  }
  if (section === 'merge') {
    return repo.state.mergeChanges.find(match)
  }
  return (
    repo.state.workingTreeChanges.find(match) ??
    repo.state.untrackedChanges?.find(match)
  )
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
    repo.state.mergeChanges,
    repo.state.untrackedChanges ?? []
  )
}

export async function stagePaths(
  getGit: () => GitApiLite | undefined,
  rootPath: string,
  paths: string[]
): Promise<void> {
  const repo = findGitRepository(getGit(), rootPath)
  if (!repo || paths.length === 0) {
    return
  }
  await repo.add(absPathsForRelative(repo.rootUri.fsPath, paths))
}

export async function unstagePaths(
  getGit: () => GitApiLite | undefined,
  rootPath: string,
  paths: string[]
): Promise<void> {
  const repo = findGitRepository(getGit(), rootPath)
  if (!repo || paths.length === 0) {
    return
  }
  const indexed = indexPathsForRelative(repo, paths)
  if (indexed.length > 0) {
    await repo.revert(indexed)
  }
}

export async function discardPaths(
  getGit: () => GitApiLite | undefined,
  rootPath: string,
  paths: string[]
): Promise<void> {
  await revertPaths(getGit, rootPath, paths, 'changes')
}

/** Drop changes for these paths. Staged paths are unstaged first, then the work tree is restored to HEAD. */
export async function revertPaths(
  getGit: () => GitApiLite | undefined,
  rootPath: string,
  paths: string[],
  section: ScmSection
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
  if (section === 'staged') {
    const indexed = indexPathsForRelative(repo, paths)
    if (indexed.length > 0) {
      await repo.revert(indexed)
    }
  }
  const toClean = fsPathsToClean(repo, paths)
  if (toClean.length > 0) {
    await repo.clean(toClean)
  }
}

function gitErrorDetail(err: unknown): string | undefined {
  if (!err || typeof err !== 'object') {
    return undefined
  }
  const record = err as Record<string, unknown>
  for (const key of ['stderr', 'gitStderr', 'stdout', 'gitStdout'] as const) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) {
      return value.trim()
    }
  }
  return undefined
}

export async function commitRepository(
  getGit: () => GitApiLite | undefined,
  rootPath: string
): Promise<void> {
  const repo = findGitRepository(getGit(), rootPath)
  if (!repo) {
    void vscode.window.showErrorMessage('Repository Tree: Git repository not found for this row.')
    return
  }
  const { indexChanges, workingTreeChanges, mergeChanges } = repo.state
  const hasStaged = indexChanges.length > 0
  const hasUnstaged = workingTreeChanges.length > 0 || mergeChanges.length > 0
  if (!hasStaged && !hasUnstaged) {
    void vscode.window.showWarningMessage('No changes to commit in this repository.')
    return
  }
  const message = await vscode.window.showInputBox({
    prompt: hasStaged ? 'Commit message' : 'Commit message (all unstaged changes will be included)',
    placeHolder: 'Message',
    value: repo.inputBox?.value ?? '',
    validateInput: (value) => (value.trim().length > 0 ? undefined : 'Message required'),
  })
  if (!message?.trim()) {
    return
  }
  const commitOpts: GitCommitOptions | undefined = hasStaged ? undefined : { all: true }
  try {
    await repo.commit(message.trim(), commitOpts)
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err)
    const fromGit = gitErrorDetail(err)
    const summary =
      raw === 'Failed to execute git' || raw.startsWith('Git: Failed to execute git')
        ? 'Git rejected the commit.'
        : raw
    const detailParts = [
      fromGit,
      'Check Output → Git for the full command log (missing user.name/user.email and pre-commit hooks are common causes).',
    ].filter(Boolean)
    void vscode.window.showErrorMessage(summary, { modal: true, detail: detailParts.join('\n\n') })
  }
}

export function pathsInSection(
  getGit: () => GitApiLite | undefined,
  rootPath: string,
  section: ScmSection,
  relativeDir: string
): string[] {
  return pathsInSectionUnderDir(mergedForRepo(getGit(), rootPath), section, relativeDir)
}

export async function openChangeDiff(
  getGit: () => GitApiLite | undefined,
  item?: RepoTreeItemLike
): Promise<void> {
  if (item?.node.kind !== 'scmFile') {
    return
  }
  const { rootPath, relativePath, section } = item.node
  const repo = findGitRepository(getGit(), rootPath)
  if (!repo) {
    return
  }

  const resource = findScmResourceForFile(repo, relativePath, section)
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

export function sectionContextValue(section: ScmSection): string {
  return `repoTree.section.${section}`
}

export function scmFileContextValue(section: ScmSection): string {
  return `repoTree.scmFile.${section}`
}

export function scmChangeDirContextValue(section: ScmSection): string {
  return `repoTree.scmChangeDir.${section}`
}

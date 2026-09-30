import * as path from 'path'
import * as vscode from 'vscode'
import type { FileChangeState, RepoTreeNode, ScmSection } from './repoTreeNode'
import { nodeRootPath } from './repoTreeNode'
import { pathsFromChanges } from './scmTree'

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

export function anyRepositoryHasStaged(git: GitApiLite | undefined): boolean {
  if (!git) {
    return false
  }
  return git.repositories.some((r) => r.state.indexChanges.length > 0)
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

export async function stagePaths(
  getGit: () => GitApiLite | undefined,
  rootPath: string,
  paths: string[]
): Promise<void> {
  const repo = findGitRepository(getGit(), rootPath)
  if (!repo || paths.length === 0) {
    return
  }
  await repo.add(paths)
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
  await repo.revert(paths)
}

export async function discardPaths(
  getGit: () => GitApiLite | undefined,
  rootPath: string,
  paths: string[],
  section: ScmSection,
  _states: FileChangeState[]
): Promise<void> {
  const repo = findGitRepository(getGit(), rootPath)
  if (!repo || paths.length === 0) {
    return
  }
  const label = paths.length === 1 ? paths[0] : `${paths.length} files`
  const ok = await vscode.window.showWarningMessage(
    `Discard changes in ${label}?`,
    { modal: true },
    'Discard'
  )
  if (ok !== 'Discard') {
    return
  }
  if (section === 'staged') {
    await repo.revert(paths)
    await repo.clean(paths)
  } else {
    await repo.clean(paths)
  }
}

export async function stageAllWorking(
  getGit: () => GitApiLite | undefined,
  rootPath: string
): Promise<void> {
  const repo = findGitRepository(getGit(), rootPath)
  if (!repo) {
    return
  }
  const paths = pathsFromChanges(repo.rootUri.fsPath, repo.state.workingTreeChanges)
  await repo.add(paths)
}

export async function unstageAllIndex(
  getGit: () => GitApiLite | undefined,
  rootPath: string
): Promise<void> {
  const repo = findGitRepository(getGit(), rootPath)
  if (!repo) {
    return
  }
  const paths = pathsFromChanges(repo.rootUri.fsPath, repo.state.indexChanges)
  await repo.revert(paths)
}

export async function commitRepoWithPrompt(
  getGit: () => GitApiLite | undefined,
  item?: RepoTreeItemLike
): Promise<void> {
  const rootPath = rootPathFromArg(item)
  if (!rootPath) {
    return
  }
  await commitRepository(getGit, rootPath, undefined)
}

export async function resolveCommitRootPath(
  getGit: () => GitApiLite | undefined,
  selectionRootPath: string | undefined
): Promise<string | undefined> {
  const git = getGit()
  if (!git) {
    return undefined
  }

  const hasStaged = (root: string) => {
    const repo = findGitRepository(git, root)
    return (repo?.state.indexChanges.length ?? 0) > 0
  }

  if (selectionRootPath && hasStaged(selectionRootPath)) {
    return selectionRootPath
  }

  const stagedRepos = git.repositories.filter((r) => r.state.indexChanges.length > 0)
  if (stagedRepos.length === 0) {
    return undefined
  }
  if (stagedRepos.length === 1) {
    return stagedRepos[0].rootUri.fsPath
  }

  const pick = await vscode.window.showQuickPick(
    stagedRepos.map((r) => ({
      label: path.basename(r.rootUri.fsPath),
      description: r.rootUri.fsPath,
      rootPath: r.rootUri.fsPath,
    })),
    { placeHolder: 'Choose repository to commit' }
  )
  return pick?.rootPath
}

async function commitRepository(
  getGit: () => GitApiLite | undefined,
  rootPath: string,
  messageOverride: string | undefined
): Promise<void> {
  const repo = findGitRepository(getGit(), rootPath)
  if (!repo) {
    return
  }

  let message = messageOverride?.trim()
  if (!message) {
    message = repo.inputBox?.value?.trim()
  }
  if (!message) {
    message = await vscode.window.showInputBox({
      prompt: 'Commit message',
      placeHolder: 'Message',
      validateInput: (v) => (v.trim() ? undefined : 'Message required'),
    })
  }
  if (!message?.trim()) {
    return
  }

  if (repo.state.indexChanges.length === 0) {
    void vscode.window.showInformationMessage('Nothing staged to commit')
    return
  }

  await repo.commit(message.trim())
}

export async function commitFromTitle(
  getGit: () => GitApiLite | undefined,
  selectionRootPath: string | undefined
): Promise<void> {
  const rootPath = await resolveCommitRootPath(getGit, selectionRootPath)
  if (!rootPath) {
    void vscode.window.showInformationMessage('No staged changes to commit')
    return
  }
  await commitRepository(getGit, rootPath, undefined)
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

  const resource = findScmResource(repo, relativePath, section)
  if (resource) {
    await resource.openChange()
    return
  }

  const uri = vscode.Uri.file(absPathForRelative(rootPath, relativePath))
  await vscode.commands.executeCommand('git.openChange', uri)
}

export async function openChangeFile(
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

  const resource = findScmResource(repo, relativePath, section)
  if (resource) {
    await resource.openFile()
    return
  }

  const uri = vscode.Uri.file(absPathForRelative(rootPath, relativePath))
  await vscode.commands.executeCommand('git.openFile', uri)
}

export function scmFileContextValue(states: FileChangeState[]): string {
  const parts = ['repoTree.scmFile']
  if (states.includes('staged')) {
    parts.push('staged')
  }
  if (states.includes('changes')) {
    parts.push('changes')
  }
  if (states.includes('merge')) {
    parts.push('merge')
  }
  return parts.join('.')
}

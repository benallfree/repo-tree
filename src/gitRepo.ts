import * as path from 'path'
import * as vscode from 'vscode'
import type { FileChangeState, RepoTreeNode } from './repoTreeNode'
import { nodeRootPath } from './repoTreeNode'
import { pathsFromChanges, relativeRepoPath } from './scmTree'

export interface GitChange {
  uri: vscode.Uri
  originalUri?: vscode.Uri
}

export interface GitRepositoryState {
  indexChanges: readonly GitChange[]
  workingTreeChanges: readonly GitChange[]
  mergeChanges: readonly GitChange[]
}

export interface GitRepositoryRef {
  rootUri: vscode.Uri
  state: GitRepositoryState
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

function findChangeInList(
  repoRoot: string,
  changes: readonly GitChange[],
  relativePath: string
): GitChange | undefined {
  return changes.find((c) => relativeRepoPath(repoRoot, c.uri.fsPath) === relativePath)
}

function pickChangeForDiff(
  repo: GitRepositoryRef,
  relativePath: string,
  states: FileChangeState[]
): GitChange | undefined {
  const root = repo.rootUri.fsPath
  if (states.includes('changes')) {
    return findChangeInList(root, repo.state.workingTreeChanges, relativePath)
  }
  if (states.includes('staged')) {
    return findChangeInList(root, repo.state.indexChanges, relativePath)
  }
  if (states.includes('merge')) {
    return findChangeInList(root, repo.state.mergeChanges, relativePath)
  }
  return undefined
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
  states: FileChangeState[]
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
  if (states.includes('staged')) {
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
  const repo = findGitRepository(getGit(), rootPath)
  if (!repo) {
    return
  }

  const message = await vscode.window.showInputBox({
    prompt: 'Commit message',
    placeHolder: 'Message',
    validateInput: (v) => (v.trim() ? undefined : 'Message required'),
  })
  if (!message?.trim()) {
    return
  }

  const staged = repo.state.indexChanges.length
  const unstaged = repo.state.workingTreeChanges.length

  if (staged === 0 && unstaged > 0) {
    const pick = await vscode.window.showInformationMessage(
      'Nothing staged. Stage all changes and commit?',
      'Stage All and Commit',
      'Cancel'
    )
    if (pick !== 'Stage All and Commit') {
      return
    }
    await stageAllWorking(getGit, rootPath)
  } else if (staged === 0) {
    void vscode.window.showInformationMessage('Nothing to commit')
    return
  }

  await repo.commit(message.trim())
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
  const change = pickChangeForDiff(repo, relativePath, states)
  if (!change) {
    return
  }
  const right = change.uri
  const left = change.originalUri ?? change.uri
  const title = `${path.basename(relativePath)} (Working Tree)`
  await vscode.commands.executeCommand('vscode.diff', left, right, title, { preview: true })
}

export async function openChangeFile(
  getGit: () => GitApiLite | undefined,
  item?: RepoTreeItemLike
): Promise<void> {
  if (item?.node.kind !== 'scmFile') {
    return
  }
  const repo = findGitRepository(getGit(), item.node.rootPath)
  if (!repo) {
    return
  }
  const change = pickChangeForDiff(repo, item.node.relativePath, item.node.states)
  const uri = change?.uri ?? vscode.Uri.file(path.join(item.node.rootPath, item.node.relativePath))
  await vscode.commands.executeCommand('vscode.open', uri)
}

export function scmFileContextValue(states: FileChangeState[]): string {
  const hasStaged = states.includes('staged')
  const hasChanges = states.includes('changes')
  const hasMerge = states.includes('merge')
  if (hasStaged && hasChanges) {
    return 'repoTree.scmFile.both'
  }
  if (hasStaged) {
    return 'repoTree.scmFile.staged'
  }
  if (hasChanges) {
    return 'repoTree.scmFile.changes'
  }
  if (hasMerge) {
    return 'repoTree.scmFile.merge'
  }
  return 'repoTree.scmFile.changes'
}

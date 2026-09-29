import * as path from 'path'
import * as vscode from 'vscode'

export interface GitRepositoryRef {
  rootUri: vscode.Uri
}

export interface GitApiLite {
  repositories: GitRepositoryRef[]
}

export interface RepoTreeItemLike {
  readonly node:
    | { kind: 'folder'; name: string; children: unknown[] }
    | { kind: 'repo'; name: string; rootPath: string }
}

function pathsEqual(a: string, b: string): boolean {
  return path.normalize(a) === path.normalize(b)
}

export function rootPathFromArg(item?: RepoTreeItemLike, rootPath?: string): string | undefined {
  if (rootPath) {
    return rootPath
  }
  if (item?.node.kind === 'repo') {
    return item.node.rootPath
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

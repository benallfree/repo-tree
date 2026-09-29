import * as vscode from 'vscode'
import { buildRepositoryTree, formatRepoDescription, type TreeNode } from './tree'

interface GitRepository {
  rootUri: vscode.Uri
  state: GitRepositoryState
}

interface GitRepositoryState {
  HEAD?: { name?: string; commit?: string; ahead?: number; behind?: number }
  indexChanges: readonly unknown[]
  workingTreeChanges: readonly unknown[]
  mergeChanges: readonly unknown[]
  onDidChange: vscode.Event<void>
}

interface GitApi {
  repositories: GitRepository[]
  onDidOpenRepository: vscode.Event<GitRepository>
  onDidCloseRepository: vscode.Event<GitRepository>
}

class RepoTreeItem extends vscode.TreeItem {
  constructor(
    public readonly node: TreeNode,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState
  ) {
    super(node.name, collapsibleState)
    if (node.kind === 'folder') {
      this.contextValue = 'repoTree.folder'
      this.iconPath = new vscode.ThemeIcon('folder')
    } else {
      this.contextValue = 'repoTree.repo'
      this.resourceUri = vscode.Uri.file(node.rootPath)
      this.tooltip = node.rootPath
      this.iconPath = new vscode.ThemeIcon('repo')
    }
  }
}

class RepositoryTreeProvider implements vscode.TreeDataProvider<RepoTreeItem> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<RepoTreeItem | undefined>()
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event

  private disposables: vscode.Disposable[] = []
  private git?: GitApi

  constructor(private readonly getGit: () => GitApi | undefined) {}

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined)
  }

  bindGit(api: GitApi): void {
    this.disposeGitListeners()
    this.git = api
    this.disposables.push(
      api.onDidOpenRepository(() => this.refresh()),
      api.onDidCloseRepository(() => this.refresh())
    )
    for (const repo of api.repositories) {
      this.watchRepo(repo)
    }
    this.refresh()
  }

  private watchRepo(repo: GitRepository): void {
    this.disposables.push(repo.state.onDidChange(() => this.refresh()))
  }

  private disposeGitListeners(): void {
    for (const d of this.disposables) {
      d.dispose()
    }
    this.disposables = []
  }

  dispose(): void {
    this.disposeGitListeners()
    this._onDidChangeTreeData.dispose()
  }

  getTreeItem(element: RepoTreeItem): vscode.TreeItem {
    return element
  }

  getChildren(element?: RepoTreeItem): RepoTreeItem[] {
    const git = this.git ?? this.getGit()
    if (!git) {
      return []
    }

    if (!element) {
      const roots = buildRepositoryTree(
        git.repositories.map((r) => ({ rootPath: r.rootUri.fsPath }))
      )
      return roots.map((node) => this.toItem(node))
    }

    if (element.node.kind === 'folder') {
      return element.node.children.map((child) => this.toItem(child))
    }

    return []
  }

  private toItem(node: TreeNode): RepoTreeItem {
    const collapsible =
      node.kind === 'folder'
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.None
    const item = new RepoTreeItem(node, collapsible)
    if (node.kind === 'repo') {
      const git = this.git ?? this.getGit()
      const repo = git?.repositories.find((r) => r.rootUri.fsPath === node.rootPath)
      if (repo) {
        const head = repo.state.HEAD
        item.description = formatRepoDescription({
          headName: head?.name,
          headCommit: head?.commit,
          indexChanges: repo.state.indexChanges.length,
          workingTreeChanges: repo.state.workingTreeChanges.length,
          mergeChanges: repo.state.mergeChanges.length,
          ahead: head?.ahead,
          behind: head?.behind,
        })
      }
      item.command = {
        command: 'repoTree.revealInExplorer',
        title: 'Reveal in Explorer',
        arguments: [node.rootPath],
      }
    }
    return item
  }
}

function getGitApi(): GitApi | undefined {
  const ext = vscode.extensions.getExtension<{ getAPI(version: number): GitApi }>('vscode.git')
  if (!ext) {
    return undefined
  }
  if (!ext.isActive) {
    return undefined
  }
  return ext.exports.getAPI(1)
}

export function activate(context: vscode.ExtensionContext): void {
  const provider = new RepositoryTreeProvider(getGitApi)

  const tree = vscode.window.createTreeView('repoTree.repositories', {
    treeDataProvider: provider,
    showCollapseAll: true,
  })
  context.subscriptions.push(tree, provider)

  const bindWhenReady = async (): Promise<void> => {
    const gitExt = vscode.extensions.getExtension('vscode.git')
    if (gitExt && !gitExt.isActive) {
      await gitExt.activate()
    }
    const api = getGitApi()
    if (api) {
      provider.bindGit(api)
    }
  }
  void bindWhenReady()

  context.subscriptions.push(
    vscode.commands.registerCommand('repoTree.refresh', () => provider.refresh()),
    vscode.commands.registerCommand('repoTree.revealInExplorer', async (rootPath?: string) => {
      const target =
        rootPath ??
        (tree.selection[0]?.node.kind === 'repo' ? tree.selection[0].node.rootPath : undefined)
      if (!target) {
        return
      }
      const uri = vscode.Uri.file(target)
      await vscode.commands.executeCommand('revealInExplorer', uri)
    }),
    vscode.commands.registerCommand('repoTree.openInNewWindow', async (item?: RepoTreeItem) => {
      const rootPath =
        item?.node.kind === 'repo'
          ? item.node.rootPath
          : tree.selection[0]?.node.kind === 'repo'
            ? tree.selection[0].node.rootPath
            : undefined
      if (!rootPath) {
        return
      }
      await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(rootPath), {
        forceNewWindow: true,
      })
    })
  )
}

export function deactivate(): void {}

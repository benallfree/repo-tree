import * as vscode from 'vscode'
import {
  buildRepositoryTree,
  flattenRepositoryTree,
  formatRepoDescription,
  pruneUnchangedTree,
  repoHasWorkingChanges,
  repoRootPath,
  sortTreeNodes,
  treeHasDirtyRepo,
  type RepoStatusInput,
  type TreeNode,
} from './tree'
import { runGitRepoCommand } from './gitRepo'
import { defaultViewOptions, loadViewOptions, type ViewOptions } from './viewState'

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

const STORAGE_KEY = 'repoTree.viewOptions'

const modifiedRepoColor = new vscode.ThemeColor('gitDecoration.modifiedResourceForeground')

class RepoTreeItem extends vscode.TreeItem {
  constructor(
    public readonly node: TreeNode,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState
  ) {
    super(node.name, collapsibleState)
    const rootPath = repoRootPath(node)
    if (rootPath) {
      this.contextValue = 'repoTree.repo'
      this.tooltip = rootPath
      return
    }
    this.contextValue = 'repoTree.folder'
    this.tooltip = node.name
  }
}

class RepositoryTreeProvider implements vscode.TreeDataProvider<RepoTreeItem> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<RepoTreeItem | undefined>()
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event

  private disposables: vscode.Disposable[] = []
  private git?: GitApi
  private viewOptions: ViewOptions = { ...defaultViewOptions }
  private readonly wipActivity = new Map<string, number>()

  constructor(private readonly getGit: () => GitApi | undefined) {}

  setViewOptions(options: ViewOptions): void {
    this.viewOptions = options
    this.refresh()
  }

  getViewOptions(): ViewOptions {
    return this.viewOptions
  }

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined)
  }

  bindGit(api: GitApi): void {
    this.disposeGitListeners()
    this.git = api
    this.disposables.push(
      api.onDidOpenRepository((repo) => {
        this.watchRepo(repo)
        this.refresh()
      }),
      api.onDidCloseRepository(() => {
        this.refresh()
      })
    )
    for (const repo of api.repositories) {
      this.watchRepo(repo)
    }
    this.refresh()
  }

  private watchRepo(repo: GitRepository): void {
    this.disposables.push(
      repo.state.onDidChange(() => {
        this.touchWipActivity(repo)
        this.refresh()
      })
    )
    this.touchWipActivity(repo)
  }

  private touchWipActivity(repo: GitRepository): void {
    const status = statusFromRepo(repo)
    if (repoHasWorkingChanges(status)) {
      this.wipActivity.set(repo.rootUri.fsPath, Date.now())
    }
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

    const isDirty = (rootPath: string) => {
      const repo = git.repositories.find((r) => r.rootUri.fsPath === rootPath)
      if (!repo) {
        return false
      }
      return repoHasWorkingChanges(statusFromRepo(repo))
    }

    if (element) {
      if (element.node.kind === 'folder') {
        return element.node.children.map((child) => this.toItem(child, isDirty))
      }
      return []
    }

    let roots = buildRepositoryTree(git.repositories.map((r) => ({ rootPath: r.rootUri.fsPath })))

    if (this.viewOptions.hideUnchanged) {
      roots = pruneUnchangedTree(roots, isDirty)
    }

    const wipRank = (rootPath: string) => this.wipActivity.get(rootPath) ?? 0
    sortTreeNodes(roots, this.viewOptions.sortMode, wipRank)

    if (this.viewOptions.layout === 'flat') {
      const flat = flattenRepositoryTree(roots)
      sortTreeNodes(flat, this.viewOptions.sortMode, wipRank)
      return flat.map((node) => this.toItem(node, isDirty))
    }

    return roots.map((node) => this.toItem(node, isDirty))
  }

  private toItem(node: TreeNode, isDirty: (rootPath: string) => boolean): RepoTreeItem {
    const rootPath = repoRootPath(node)
    const collapsible =
      node.kind === 'folder' && node.children.length > 0
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None
    const item = new RepoTreeItem(node, collapsible)
    // ThemeIcon 'folder' does not count as an icon unless the file-icon theme
    // provides folder icons. The tree then drops the twistie column on sibling
    // leaves. 'symbol-folder' is the same glyph and always reserves that column.
    const iconId = rootPath ? 'repo' : 'symbol-folder'
    if (treeHasDirtyRepo(node, isDirty)) {
      item.iconPath = new vscode.ThemeIcon(iconId, modifiedRepoColor)
      item.label = { label: node.name, highlights: [[0, node.name.length]] }
    } else {
      item.iconPath = new vscode.ThemeIcon(iconId)
    }
    if (rootPath) {
      item.command = {
        command: 'repoTree.revealInExplorer',
        title: 'Reveal in Explorer',
        arguments: [rootPath],
      }
      const git = this.git ?? this.getGit()
      const repo = git?.repositories.find((r) => r.rootUri.fsPath === rootPath)
      if (repo) {
        const status = statusFromRepo(repo)
        const head = repo.state.HEAD
        item.description = formatRepoDescription({
          headName: head?.name,
          headCommit: head?.commit,
          indexChanges: status.indexChanges,
          workingTreeChanges: status.workingTreeChanges,
          mergeChanges: status.mergeChanges,
          ahead: head?.ahead,
          behind: head?.behind,
        })
      }
    }
    return item
  }
}

function statusFromRepo(repo: GitRepository): RepoStatusInput {
  return {
    indexChanges: repo.state.indexChanges.length,
    workingTreeChanges: repo.state.workingTreeChanges.length,
    mergeChanges: repo.state.mergeChanges.length,
  }
}

function getGitApi(): GitApi | undefined {
  const ext = vscode.extensions.getExtension<{ getAPI(version: number): GitApi }>('vscode.git')
  if (!ext?.isActive) {
    return undefined
  }
  return ext.exports.getAPI(1)
}

async function syncViewContext(options: ViewOptions): Promise<void> {
  await vscode.commands.executeCommand('setContext', 'repoTree.layout', options.layout)
  await vscode.commands.executeCommand('setContext', 'repoTree.sortMode', options.sortMode)
  await vscode.commands.executeCommand('setContext', 'repoTree.hideUnchanged', options.hideUnchanged)
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const stored = loadViewOptions(context.globalState.get<Partial<ViewOptions>>(STORAGE_KEY))
  await syncViewContext(stored)

  const provider = new RepositoryTreeProvider(getGitApi)

  const persistOptions = (options: ViewOptions): void => {
    void context.globalState.update(STORAGE_KEY, options)
    void syncViewContext(options)
  }
  provider.setViewOptions(stored)

  const tree = vscode.window.createTreeView('repoTree.repositories', {
    treeDataProvider: provider,
    showCollapseAll: true,
  })
  context.subscriptions.push(tree, provider)

  const updateOptions = (patch: Partial<ViewOptions>): void => {
    const next = { ...provider.getViewOptions(), ...patch }
    provider.setViewOptions(next)
    persistOptions(next)
  }

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
    vscode.commands.registerCommand('repoTree.setLayoutTree', () => updateOptions({ layout: 'tree' })),
    vscode.commands.registerCommand('repoTree.setLayoutFlat', () => updateOptions({ layout: 'flat' })),
    vscode.commands.registerCommand('repoTree.setSortName', () => updateOptions({ sortMode: 'name' })),
    vscode.commands.registerCommand('repoTree.setSortWip', () => updateOptions({ sortMode: 'wip' })),
    vscode.commands.registerCommand('repoTree.toggleHideUnchanged', () => {
      const cur = provider.getViewOptions()
      updateOptions({ hideUnchanged: !cur.hideUnchanged })
    }),
    vscode.commands.registerCommand('repoTree.revealInExplorer', async (arg?: string | RepoTreeItem) => {
      const target =
        typeof arg === 'string'
          ? arg
          : arg
            ? repoRootPath(arg.node)
            : tree.selection[0]
              ? repoRootPath(tree.selection[0].node)
              : undefined
      if (!target) {
        return
      }
      await vscode.commands.executeCommand('revealInExplorer', vscode.Uri.file(target))
    }),
    vscode.commands.registerCommand('repoTree.gitSync', (item?: RepoTreeItem) =>
      runGitRepoCommand(getGitApi, 'git.sync', item)
    ),
    vscode.commands.registerCommand('repoTree.gitPull', (item?: RepoTreeItem) =>
      runGitRepoCommand(getGitApi, 'git.pull', item)
    ),
    vscode.commands.registerCommand('repoTree.gitPush', (item?: RepoTreeItem) =>
      runGitRepoCommand(getGitApi, 'git.push', item)
    ),
    vscode.commands.registerCommand('repoTree.gitCommit', (item?: RepoTreeItem) =>
      runGitRepoCommand(getGitApi, 'git.commit', item)
    ),
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

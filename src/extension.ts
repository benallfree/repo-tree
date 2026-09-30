import * as path from 'path'
import * as vscode from 'vscode'
import {
  findGitRepository,
  findScmResourceForFile,
  openChangeDiff,
  openChangeFile,
  revertFolder,
  revertPaths,
  runGitRepoCommand,
  SCM_CHANGE_DIR_CONTEXT,
  SCM_FILE_CONTEXT,
  type GitRepositoryRef,
} from './gitRepo'
import { nodeRootPath, stableNodeId, type RepoTreeNode } from './repoTreeNode'
import { childrenOfChangeDir, mergeRepoChanges, nestChangePaths, type NestedChangeNode } from './scmTree'
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
import { defaultViewOptions, loadViewOptions, type ViewOptions } from './viewState'

type GitRepository = GitRepositoryRef & {
  state: GitRepositoryRef['state'] & {
    HEAD?: { name?: string; commit?: string; ahead?: number; behind?: number }
    onDidChange: vscode.Event<void>
  }
}

interface GitApi {
  repositories: GitRepository[]
  onDidOpenRepository: vscode.Event<GitRepository>
  onDidCloseRepository: vscode.Event<GitRepository>
}

const STORAGE_KEY = 'repoTree.viewOptions'

const modifiedRepoColor = new vscode.ThemeColor('gitDecoration.modifiedResourceForeground')

export class RepoTreeItem extends vscode.TreeItem {
  constructor(
    public readonly node: RepoTreeNode,
    public readonly treeId: string,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState
  ) {
    super('', collapsibleState)
    this.id = treeId
    this.label = labelForNode(node)

    if (node.kind === 'scmChangeDir') {
      this.contextValue = SCM_CHANGE_DIR_CONTEXT
      this.tooltip = path.join(node.rootPath, node.relativeDir)
      this.iconPath = new vscode.ThemeIcon('symbol-folder')
      return
    }
    if (node.kind === 'scmFile') {
      this.contextValue = SCM_FILE_CONTEXT
      this.tooltip = path.join(node.rootPath, node.relativePath)
      this.iconPath = new vscode.ThemeIcon('file')
      this.command = {
        command: 'repoTree.openDiff',
        title: 'Open Diff',
        arguments: [this],
      }
      return
    }

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

function labelForNode(node: RepoTreeNode): string {
  return node.name
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
    this.applyScmResourceStyle(element)
    return element
  }

  private applyScmResourceStyle(item: RepoTreeItem): void {
    const node = item.node
    if (node.kind !== 'scmFile') {
      return
    }
    const git = this.git ?? this.getGit()
    const repo = git ? findGitRepository(git, node.rootPath) : undefined
    const fileUri = vscode.Uri.file(path.join(node.rootPath, node.relativePath))
    item.resourceUri = fileUri

    const resource = repo ? findScmResourceForFile(repo, node.relativePath, node.states) : undefined
    if (!resource) {
      return
    }
    if (resource.letter) {
      item.description = resource.letter
    }
    if (resource.tooltip) {
      item.tooltip = resource.tooltip
    }
  }

  getChildren(element?: RepoTreeItem): RepoTreeItem[] {
    const git = this.git ?? this.getGit()
    if (!git) {
      return []
    }

    const isDirty = (rootPath: string) => {
      const repo = findGitRepository(git, rootPath)
      if (!repo) {
        return false
      }
      return repoHasWorkingChanges(statusFromRepo(repo))
    }

    if (element) {
      const { node, treeId } = element
      if (node.kind === 'scmChangeDir') {
        return this.changeItemsAt(node.rootPath, git, node.relativeDir, treeId)
      }
      if (node.kind === 'scmFile') {
        return []
      }

      const rootPath = repoRootPath(node)
      const items: RepoTreeItem[] = []

      if (rootPath && isDirty(rootPath)) {
        items.push(...this.changeItemsForRepo(rootPath, git, treeId))
      }

      if (node.kind === 'folder') {
        items.push(...node.children.map((child) => this.toItem(child, isDirty, treeId)))
      }

      return items
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

  private mergedForRepo(rootPath: string, git: GitApi) {
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

  private changeItemsForRepo(rootPath: string, git: GitApi, parentTreeId: string): RepoTreeItem[] {
    const nested = nestChangePaths(this.mergedForRepo(rootPath, git), this.viewOptions.layout === 'flat')
    return nested.map((n) => this.nestedToItem(n, rootPath, parentTreeId))
  }

  private changeItemsAt(
    rootPath: string,
    git: GitApi,
    relativeDir: string,
    parentTreeId: string
  ): RepoTreeItem[] {
    const nested = nestChangePaths(this.mergedForRepo(rootPath, git), this.viewOptions.layout === 'flat')
    const level = childrenOfChangeDir(nested, relativeDir)
    return level.map((n) => this.nestedToItem(n, rootPath, parentTreeId))
  }

  getChildItems(element?: RepoTreeItem): RepoTreeItem[] {
    return this.getChildren(element)
  }

  private nestedToItem(node: NestedChangeNode, rootPath: string, parentTreeId: string): RepoTreeItem {
    if (node.kind === 'file') {
      const treeNode: RepoTreeNode = {
        kind: 'scmFile',
        rootPath,
        relativePath: node.relativePath,
        name: node.name,
        states: node.states,
      }
      return new RepoTreeItem(
        treeNode,
        stableNodeId(treeNode, parentTreeId),
        vscode.TreeItemCollapsibleState.None
      )
    }
    const treeNode: RepoTreeNode = {
      kind: 'scmChangeDir',
      rootPath,
      relativeDir: node.relativeDir,
      name: node.name,
    }
    return new RepoTreeItem(
      treeNode,
      stableNodeId(treeNode, parentTreeId),
      node.children.length > 0
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.None
    )
  }

  private toItem(node: TreeNode, isDirty: (rootPath: string) => boolean, parentId?: string): RepoTreeItem {
    const treeId = stableNodeId(node, parentId)
    const rootPath = repoRootPath(node)
    const hasPathChildren = node.kind === 'folder' && node.children.length > 0
    const dirty = rootPath ? isDirty(rootPath) : false
    const collapsible =
      hasPathChildren || dirty
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None
    const item = new RepoTreeItem(node, treeId, collapsible)
    const iconId = rootPath ? 'repo' : 'symbol-folder'
    if (treeHasDirtyRepo(node, isDirty)) {
      item.iconPath = new vscode.ThemeIcon(iconId, modifiedRepoColor)
      item.label = { label: node.name, highlights: [[0, node.name.length]] }
    } else {
      item.iconPath = new vscode.ThemeIcon(iconId)
    }
    if (rootPath) {
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

function statusFromRepo(repo: GitRepositoryRef): RepoStatusInput {
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

function resolveTreeItem(
  tree: vscode.TreeView<RepoTreeItem>,
  item?: RepoTreeItem
): RepoTreeItem | undefined {
  if (item?.node) {
    return item
  }
  return tree.selection[0]
}

function scmFileFromItem(
  tree: vscode.TreeView<RepoTreeItem>,
  item?: RepoTreeItem
): Extract<RepoTreeNode, { kind: 'scmFile' }> | undefined {
  const resolved = resolveTreeItem(tree, item)
  if (resolved?.node.kind === 'scmFile') {
    return resolved.node
  }
  return undefined
}

function scmChangeDirFromItem(
  tree: vscode.TreeView<RepoTreeItem>,
  item?: RepoTreeItem
): Extract<RepoTreeNode, { kind: 'scmChangeDir' }> | undefined {
  const resolved = resolveTreeItem(tree, item)
  if (resolved?.node.kind === 'scmChangeDir') {
    return resolved.node
  }
  return undefined
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

  const expandRepoSubtree = async (root: RepoTreeItem): Promise<void> => {
    const queue: RepoTreeItem[] = [root]
    const seen = new Set<string>()
    while (queue.length > 0) {
      const item = queue.shift()!
      if (seen.has(item.treeId)) {
        continue
      }
      seen.add(item.treeId)
      const children = provider.getChildItems(item)
      for (const child of children) {
        if (child.collapsibleState === vscode.TreeItemCollapsibleState.None) {
          continue
        }
        try {
          await tree.reveal(child, { expand: true, select: false, focus: false })
        } catch {
          // reveal fails if the node is not yet materialized; skip
        }
        queue.push(child)
      }
    }
  }

  context.subscriptions.push(
    tree.onDidExpandElement((event) => {
      if (event.element.node.kind === 'repo') {
        void expandRepoSubtree(event.element)
      }
    })
  )

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

  const syncGraphContext = (): void => {
    void vscode.commands.executeCommand(
      'setContext',
      'repoTree.gitGraph',
      !!vscode.extensions.getExtension('mhutchie.git-graph')
    )
    void vscode.commands.executeCommand(
      'setContext',
      'repoTree.gitLens',
      !!vscode.extensions.getExtension('eamodio.gitlens')
    )
  }
  syncGraphContext()
  context.subscriptions.push(vscode.extensions.onDidChange(syncGraphContext))

  const openRepoGraph = async (command: string, item?: RepoTreeItem): Promise<void> => {
    const rootPath = item
      ? nodeRootPath(item.node)
      : tree.selection[0]
        ? nodeRootPath(tree.selection[0].node)
        : undefined
    if (!rootPath) {
      return
    }
    await vscode.commands.executeCommand(command, { rootUri: vscode.Uri.file(rootPath) })
  }

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
      let target: string | undefined
      if (typeof arg === 'string') {
        target = arg
      } else if (arg?.node.kind === 'scmFile') {
        target = path.join(arg.node.rootPath, arg.node.relativePath)
      } else if (arg) {
        target = nodeRootPath(arg.node)
      } else if (tree.selection[0]) {
        const sel = tree.selection[0]
        target =
          sel.node.kind === 'scmFile'
            ? path.join(sel.node.rootPath, sel.node.relativePath)
            : nodeRootPath(sel.node)
      }
      if (!target) {
        return
      }
      await vscode.commands.executeCommand('revealInExplorer', vscode.Uri.file(target))
    }),
    vscode.commands.registerCommand('repoTree.openDiff', (item?: RepoTreeItem) =>
      openChangeDiff(getGitApi, item)
    ),
    vscode.commands.registerCommand('repoTree.openFile', (item?: RepoTreeItem) =>
      openChangeFile(getGitApi, item)
    ),
    vscode.commands.registerCommand('repoTree.gitSync', (item?: RepoTreeItem) =>
      runGitRepoCommand(getGitApi, 'git.sync', item)
    ),
    vscode.commands.registerCommand('repoTree.gitPull', (item?: RepoTreeItem) =>
      runGitRepoCommand(getGitApi, 'git.pull', item)
    ),
    vscode.commands.registerCommand('repoTree.gitPush', (item?: RepoTreeItem) =>
      runGitRepoCommand(getGitApi, 'git.push', item)
    ),
    vscode.commands.registerCommand('repoTree.revertFile', (item?: RepoTreeItem) => {
      const file = scmFileFromItem(tree, item)
      if (!file) {
        return
      }
      void revertPaths(getGitApi, file.rootPath, [file.relativePath])
    }),
    vscode.commands.registerCommand('repoTree.revertFolder', (item?: RepoTreeItem) => {
      const dir = scmChangeDirFromItem(tree, item)
      if (!dir) {
        return
      }
      void revertFolder(getGitApi, dir.rootPath, dir.relativeDir)
    }),
    vscode.commands.registerCommand('repoTree.viewGitGraph', (item?: RepoTreeItem) => {
      void openRepoGraph('git-graph.view', item)
    }),
    vscode.commands.registerCommand('repoTree.viewCommitGraph', (item?: RepoTreeItem) => {
      void openRepoGraph('gitlens.showGraph', item)
    }),
    vscode.commands.registerCommand('repoTree.openInNewWindow', async (item?: RepoTreeItem) => {
      const rootPath = item ? nodeRootPath(item.node) : tree.selection[0] ? nodeRootPath(tree.selection[0].node) : undefined
      if (!rootPath) {
        return
      }
      await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(rootPath), {
        forceNewWindow: true,
      })
    })
  )

  const updateOptions = (patch: Partial<ViewOptions>): void => {
    const next = { ...provider.getViewOptions(), ...patch }
    provider.setViewOptions(next)
    persistOptions(next)
  }
}

export function deactivate(): void {}

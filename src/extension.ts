import * as path from 'path'
import * as vscode from 'vscode'
import {
  commitRepository,
  discardPaths,
  findGitRepository,
  findScmResourceForFile,
  openChangeDiff,
  openChangeFile,
  pathsInSection,
  runGitRepoCommand,
  scmChangeDirContextValue,
  scmFileContextValue,
  sectionContextValue,
  stagePaths,
  unstagePaths,
  type GitRepositoryRef,
} from './gitRepo'
import { appendGitignoreLine, toGitignorePattern } from './gitignore'
import { nodeRootPath, scmSectionTreeId, stableNodeId, type RepoTreeNode } from './repoTreeNode'
import {
  childrenOfChangeDir,
  filesForSection,
  mergeRepoChanges,
  nestChangePaths,
  repoSectionHasFiles,
  SCM_SECTION_LABELS,
  SCM_SECTION_ORDER,
  type NestedChangeNode,
  type ScmSection,
} from './scmTree'
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
import { TreeExpansionSession } from './treeExpansion'
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

    if (node.kind === 'scmSection') {
      this.contextValue = sectionContextValue(node.section)
      this.tooltip = node.name
      this.iconPath = new vscode.ThemeIcon('list-tree')
      return
    }
    if (node.kind === 'scmChangeDir') {
      this.contextValue = scmChangeDirContextValue(node.section)
      this.tooltip = path.join(node.rootPath, node.relativeDir)
      this.iconPath = new vscode.ThemeIcon('symbol-folder')
      return
    }
    if (node.kind === 'scmFile') {
      this.contextValue = scmFileContextValue(node.section)
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
  readonly expansion = new TreeExpansionSession()
  private syncingRootPath?: string

  constructor(private readonly getGit: () => GitApi | undefined) {}

  setSyncingRoot(rootPath: string): void {
    this.syncingRootPath = rootPath
    this.refresh()
  }

  clearSyncingRoot(): void {
    if (!this.syncingRootPath) {
      return
    }
    this.syncingRootPath = undefined
    this.refresh()
  }

  isSyncingRoot(rootPath: string): boolean {
    return this.syncingRootPath === rootPath
  }

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

  findRepoItem(rootPath: string): RepoTreeItem | undefined {
    const isRepoRow = (node: RepoTreeNode): boolean =>
      node.kind === 'repo' ||
      (node.kind === 'folder' && Boolean(node.rootPath) && node.rootPath === rootPath)

    const walk = (items: RepoTreeItem[]): RepoTreeItem | undefined => {
      for (const item of items) {
        if (isRepoRow(item.node)) {
          return item
        }
        const kids = this.getChildren(item)
        const found = walk(kids)
        if (found) {
          return found
        }
      }
      return undefined
    }
    return walk(this.getChildren())
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
    this.applyRepoSyncContext(element)
    this.expansion.applyToItem(element)
    this.applyScmResourceStyle(element)
    return element
  }

  private applyRepoSyncContext(item: RepoTreeItem): void {
    const rootPath =
      item.node.kind === 'repo'
        ? item.node.rootPath
        : item.node.kind === 'folder'
          ? item.node.rootPath
          : undefined
    if (rootPath && this.isSyncingRoot(rootPath)) {
      item.contextValue = 'repoTree.repo.syncing'
    }
  }

  /** Mark every collapsible node under `root` as expanded (first repo open in session). */
  seedSubtreeExpanded(root: RepoTreeItem): void {
    const queue: RepoTreeItem[] = [root]
    const seen = new Set<string>()
    while (queue.length > 0) {
      const item = queue.shift()!
      if (seen.has(item.treeId)) {
        continue
      }
      seen.add(item.treeId)
      if (item.collapsibleState !== vscode.TreeItemCollapsibleState.None) {
        this.expansion.markExpanded(item.treeId)
      }
      for (const child of this.getChildren(item)) {
        queue.push(child)
      }
    }
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

    const resource = repo ? findScmResourceForFile(repo, node.relativePath, node.section) : undefined
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
      if (node.kind === 'scmSection') {
        return this.changeItemsForSection(node.rootPath, git, node.section, treeId, '')
      }
      if (node.kind === 'scmChangeDir') {
        return this.changeItemsForSection(
          node.rootPath,
          git,
          node.section,
          treeId,
          node.relativeDir
        )
      }
      if (node.kind === 'scmFile') {
        return []
      }

      const rootPath = repoRootPath(node)
      const items: RepoTreeItem[] = []

      if (rootPath && isDirty(rootPath)) {
        items.push(...this.sectionItemsForRepo(rootPath, git, treeId))
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

  private sectionItemsForRepo(rootPath: string, git: GitApi, parentTreeId: string): RepoTreeItem[] {
    const merged = this.mergedForRepo(rootPath, git)
    return SCM_SECTION_ORDER.filter((section) => repoSectionHasFiles(merged, section)).map(
      (section) => {
        const treeNode: RepoTreeNode = {
          kind: 'scmSection',
          rootPath,
          section,
          name: SCM_SECTION_LABELS[section],
        }
        const treeId = stableNodeId(treeNode, parentTreeId)
        return new RepoTreeItem(
          treeNode,
          treeId,
          this.expansion.collapsibleState(treeId, true)
        )
      }
    )
  }

  private changeItemsForSection(
    rootPath: string,
    git: GitApi,
    section: ScmSection,
    parentTreeId: string,
    relativeDir: string
  ): RepoTreeItem[] {
    const merged = this.mergedForRepo(rootPath, git)
    const sectionFiles = filesForSection(merged, section)
    const nested = nestChangePaths(sectionFiles, this.viewOptions.layout === 'flat')
    const level =
      relativeDir === '' ? nested : childrenOfChangeDir(nested, relativeDir)
    return level.map((n) => this.nestedToItem(n, rootPath, section, parentTreeId))
  }

  getChildItems(element?: RepoTreeItem): RepoTreeItem[] {
    return this.getChildren(element)
  }

  private nestedToItem(
    node: NestedChangeNode,
    rootPath: string,
    section: ScmSection,
    parentTreeId: string
  ): RepoTreeItem {
    if (node.kind === 'file') {
      const treeNode: RepoTreeNode = {
        kind: 'scmFile',
        rootPath,
        section,
        relativePath: node.relativePath,
        name: node.name,
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
      section,
      relativeDir: node.relativeDir,
      name: node.name,
    }
    const treeId = stableNodeId(treeNode, parentTreeId)
    const hasChildren = node.children.length > 0
    return new RepoTreeItem(
      treeNode,
      treeId,
      this.expansion.collapsibleState(treeId, hasChildren)
    )
  }

  private toItem(node: TreeNode, isDirty: (rootPath: string) => boolean, parentId?: string): RepoTreeItem {
    const treeId = stableNodeId(node, parentId)
    const rootPath = repoRootPath(node)
    const hasPathChildren = node.kind === 'folder' && node.children.length > 0
    const dirty = rootPath ? isDirty(rootPath) : false
    const hasChildren = hasPathChildren || dirty
    const collapsible = this.expansion.collapsibleState(treeId, hasChildren)
    const item = new RepoTreeItem(node, treeId, collapsible)
    const iconId = rootPath ? 'repo' : 'symbol-folder'
    if (treeHasDirtyRepo(node, isDirty)) {
      item.iconPath = new vscode.ThemeIcon(iconId, modifiedRepoColor)
      item.label = { label: node.name, highlights: [[0, node.name.length]] }
    } else {
      item.iconPath = new vscode.ThemeIcon(iconId)
    }
    if (rootPath && this.isSyncingRoot(rootPath)) {
      item.contextValue = 'repoTree.repo.syncing'
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

/** Drives view/title SCM actions from the current tree selection (inline row icons are hover-only). */
function selectionKindFromNode(node: RepoTreeNode): string {
  if (node.kind === 'scmSection') {
    return `section.${node.section}`
  }
  if (node.kind === 'scmChangeDir') {
    return `dir.${node.section}`
  }
  if (node.kind === 'scmFile') {
    return `file.${node.section}`
  }
  if (node.kind === 'repo' || (node.kind === 'folder' && node.rootPath)) {
    return 'repo'
  }
  return 'none'
}

async function syncSelectionContext(tree: vscode.TreeView<RepoTreeItem>): Promise<void> {
  const kind = tree.selection[0] ? selectionKindFromNode(tree.selection[0].node) : 'none'
  await vscode.commands.executeCommand('setContext', 'repoTree.selectionKind', kind)
}

function repoHadStagedSection(rootPath: string): boolean {
  const git = getGitApi()
  const repo = git ? findGitRepository(git, rootPath) : undefined
  if (!repo) {
    return false
  }
  return repoSectionHasFiles(
    mergeRepoChanges(
      repo.rootUri.fsPath,
      repo.state.indexChanges,
      repo.state.workingTreeChanges,
      repo.state.mergeChanges
    ),
    'staged'
  )
}

async function revealStagedChangesSection(
  tree: vscode.TreeView<RepoTreeItem>,
  provider: RepositoryTreeProvider,
  rootPath: string
): Promise<void> {
  const sectionNode: RepoTreeNode = {
    kind: 'scmSection',
    rootPath,
    section: 'staged',
    name: SCM_SECTION_LABELS.staged,
  }
  const sectionItem = new RepoTreeItem(
    sectionNode,
    stableNodeId(sectionNode),
    vscode.TreeItemCollapsibleState.Expanded
  )

  for (const delayMs of [0, 50, 150, 300]) {
    if (delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs))
    }
    try {
      const repoItem = provider.findRepoItem(rootPath)
      if (repoItem) {
        await tree.reveal(repoItem, { expand: true, select: false, focus: false })
      }
      await tree.reveal(sectionItem, { expand: true, select: false, focus: false })
      return
    } catch {
      // Tree nodes may not exist until Git refresh finishes.
    }
  }
}

async function runGitSync(
  provider: RepositoryTreeProvider,
  tree: vscode.TreeView<RepoTreeItem>,
  item?: RepoTreeItem
): Promise<void> {
  const resolved = resolveTreeItem(tree, item)
  const rootPath = resolved ? nodeRootPath(resolved.node) : undefined
  if (!rootPath || provider.isSyncingRoot(rootPath)) {
    return
  }
  provider.setSyncingRoot(rootPath)
  try {
    await runGitRepoCommand(getGitApi, 'git.sync', resolved)
  } finally {
    provider.clearSyncingRoot()
  }
}

async function runStageWithReveal(
  provider: RepositoryTreeProvider,
  tree: vscode.TreeView<RepoTreeItem>,
  rootPath: string,
  paths: string[],
  sourceSection: ScmSection
): Promise<void> {
  if (paths.length === 0) {
    return
  }
  const hadStaged = repoHadStagedSection(rootPath)
  provider.expansion.copySectionExpansion(rootPath, sourceSection, 'staged', paths)
  if (!hadStaged) {
    provider.expansion.markExpanded(scmSectionTreeId(rootPath, 'staged'))
  }
  await stagePaths(getGitApi, rootPath, paths)
  provider.refresh()
  if (!hadStaged) {
    await revealStagedChangesSection(tree, provider, rootPath)
  }
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

function scmSectionFromItem(
  tree: vscode.TreeView<RepoTreeItem>,
  item?: RepoTreeItem
): Extract<RepoTreeNode, { kind: 'scmSection' }> | undefined {
  const resolved = resolveTreeItem(tree, item)
  if (resolved?.node.kind === 'scmSection') {
    return resolved.node
  }
  return undefined
}

function gitignoreTarget(item?: RepoTreeItem): { rootPath: string; entry: string } | undefined {
  if (item?.node.kind === 'scmFile') {
    return { rootPath: item.node.rootPath, entry: toGitignorePattern(item.node.relativePath, false) }
  }
  if (item?.node.kind === 'scmChangeDir' && item.node.relativeDir) {
    return { rootPath: item.node.rootPath, entry: toGitignorePattern(item.node.relativeDir, true) }
  }
  return undefined
}

function sectionScopeFromItem(
  tree: vscode.TreeView<RepoTreeItem>,
  item?: RepoTreeItem
): { rootPath: string; section: ScmSection; relativeDir: string } | undefined {
  const section = scmSectionFromItem(tree, item)
  if (section) {
    return { rootPath: section.rootPath, section: section.section, relativeDir: '' }
  }
  const dir = scmChangeDirFromItem(tree, item)
  if (dir) {
    return { rootPath: dir.rootPath, section: dir.section, relativeDir: dir.relativeDir }
  }
  return undefined
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const stored = loadViewOptions(context.globalState.get<Partial<ViewOptions>>(STORAGE_KEY))
  await syncViewContext(stored)
  await vscode.commands.executeCommand('setContext', 'repoTree.selectionKind', 'none')

  const provider = new RepositoryTreeProvider(getGitApi)

  const persistOptions = (options: ViewOptions): void => {
    void context.globalState.update(STORAGE_KEY, options)
    void syncViewContext(options)
  }
  provider.setViewOptions(stored)

  const addPathToGitignore = async (item?: RepoTreeItem): Promise<void> => {
    const target = gitignoreTarget(item)
    if (!target) {
      return
    }
    const uri = vscode.Uri.file(path.join(target.rootPath, '.gitignore'))
    let doc: vscode.TextDocument
    try {
      doc = await vscode.workspace.openTextDocument(uri)
    } catch {
      await vscode.workspace.fs.writeFile(uri, new Uint8Array())
      doc = await vscode.workspace.openTextDocument(uri)
    }
    const next = appendGitignoreLine(doc.getText(), target.entry)
    if (next !== null) {
      const edit = new vscode.WorkspaceEdit()
      const end = doc.lineAt(Math.max(doc.lineCount - 1, 0)).range.end
      const start = doc.positionAt(0)
      edit.replace(doc.uri, new vscode.Range(start, end), next)
      const applied = await vscode.workspace.applyEdit(edit)
      if (!applied || !(await doc.save())) {
        void vscode.window.showErrorMessage(`Could not update .gitignore in ${target.rootPath}`)
        return
      }
    }
    await vscode.window.showTextDocument(doc, { preview: true })
    provider.refresh()
  }

  const tree = vscode.window.createTreeView('repoTree.repositories', {
    treeDataProvider: provider,
    showCollapseAll: true,
  })
  context.subscriptions.push(tree, provider)

  context.subscriptions.push(
    tree.onDidChangeSelection(() => {
      void syncSelectionContext(tree)
    })
  )
  void syncSelectionContext(tree)

  const repoRootFromTreeNode = (node: RepoTreeNode): string | undefined => {
    if (node.kind === 'repo') {
      return node.rootPath
    }
    if (node.kind === 'folder' && node.rootPath) {
      return node.rootPath
    }
    return undefined
  }

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
        provider.expansion.markExpanded(child.treeId)
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
      const item = event.element
      provider.expansion.recordExpanded(item.treeId, true)
      const repoRoot = repoRootFromTreeNode(item.node)
      if (repoRoot && !provider.expansion.hasRepoOpenedInSession(repoRoot)) {
        provider.expansion.markRepoOpenedInSession(repoRoot)
        provider.seedSubtreeExpanded(item)
        void expandRepoSubtree(item)
      }
    }),
    tree.onDidCollapseElement((event) => {
      provider.expansion.recordExpanded(event.element.treeId, false)
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
      openChangeDiff(getGitApi, resolveTreeItem(tree, item))
    ),
    vscode.commands.registerCommand('repoTree.openFile', (item?: RepoTreeItem) =>
      openChangeFile(getGitApi, resolveTreeItem(tree, item))
    ),
    vscode.commands.registerCommand('repoTree.gitSync', (item?: RepoTreeItem) => {
      void runGitSync(provider, tree, item)
    }),
    vscode.commands.registerCommand('repoTree.gitSyncBusy', () => {
      // Spinning affordance only; sync runs via repoTree.gitSync.
    }),
    vscode.commands.registerCommand('repoTree.gitPull', (item?: RepoTreeItem) =>
      runGitRepoCommand(getGitApi, 'git.pull', item)
    ),
    vscode.commands.registerCommand('repoTree.gitPush', (item?: RepoTreeItem) =>
      runGitRepoCommand(getGitApi, 'git.push', item)
    ),
    vscode.commands.registerCommand('repoTree.commit', (item?: RepoTreeItem) => {
      const resolved = resolveTreeItem(tree, item)
      const rootPath = resolved ? nodeRootPath(resolved.node) : undefined
      if (!rootPath) {
        return
      }
      void commitRepository(getGitApi, rootPath)
    }),
    vscode.commands.registerCommand('repoTree.stageFile', (item?: RepoTreeItem) => {
      const file = scmFileFromItem(tree, item)
      if (!file || (file.section !== 'changes' && file.section !== 'merge')) {
        return
      }
      void runStageWithReveal(provider, tree, file.rootPath, [file.relativePath], file.section)
    }),
    vscode.commands.registerCommand('repoTree.unstageFile', (item?: RepoTreeItem) => {
      const file = scmFileFromItem(tree, item)
      if (!file || file.section !== 'staged') {
        return
      }
      void unstagePaths(getGitApi, file.rootPath, [file.relativePath])
    }),
    vscode.commands.registerCommand('repoTree.discardFile', (item?: RepoTreeItem) => {
      const file = scmFileFromItem(tree, item)
      if (!file || file.section !== 'changes') {
        return
      }
      void discardPaths(getGitApi, file.rootPath, [file.relativePath])
    }),
    vscode.commands.registerCommand('repoTree.stageAllInScope', (item?: RepoTreeItem) => {
      const scope = sectionScopeFromItem(tree, item)
      if (!scope || scope.section === 'staged') {
        return
      }
      const paths = pathsInSection(getGitApi, scope.rootPath, scope.section, scope.relativeDir)
      void runStageWithReveal(provider, tree, scope.rootPath, paths, scope.section)
    }),
    vscode.commands.registerCommand('repoTree.unstageAllInScope', (item?: RepoTreeItem) => {
      const scope = sectionScopeFromItem(tree, item)
      if (!scope || scope.section !== 'staged') {
        return
      }
      const paths = pathsInSection(getGitApi, scope.rootPath, scope.section, scope.relativeDir)
      void unstagePaths(getGitApi, scope.rootPath, paths)
    }),
    vscode.commands.registerCommand('repoTree.discardAllInScope', (item?: RepoTreeItem) => {
      const scope = sectionScopeFromItem(tree, item)
      if (!scope || scope.section !== 'changes') {
        return
      }
      const paths = pathsInSection(getGitApi, scope.rootPath, scope.section, scope.relativeDir)
      void discardPaths(getGitApi, scope.rootPath, paths)
    }),
    vscode.commands.registerCommand('repoTree.addToGitignore', (item?: RepoTreeItem) => {
      void addPathToGitignore(resolveTreeItem(tree, item))
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

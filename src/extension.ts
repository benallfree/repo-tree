import * as path from 'path'
import * as vscode from 'vscode'
import {
  commitRepository,
  discardPaths,
  revertPaths,
  findChangeForSection,
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
  type GitChange,
  type GitRepositoryRef,
} from './gitRepo'
import { appendGitignoreLine, toGitignorePattern } from './gitignore'
import { nodeRootPath, scmSectionTreeId, stableNodeId, type RepoTreeNode } from './repoTreeNode'
import {
  filesForSection,
  indexSectionChanges,
  mergeRepoChanges,
  nestChangePaths,
  nestedDirChildren,
  pathListSignature,
  relativeRepoPath,
  repoSectionHasFiles,
  SCM_SECTION_LABELS,
  SCM_SECTION_ORDER,
  type MergedChangeFile,
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
import { RepoWebviewViewProvider, type RepoSnap, type RepoViewMessage } from './repoWebview'
import {
  scmChangeDirExpandFallback,
  scmSectionExpandFallback,
  TreeExpansionSession,
} from './treeExpansion'
import { formatStatusBadge, statusCssClass, type GitStatusValue } from './gitStatus'
import { defaultViewOptions, loadViewOptions, type ViewOptions } from './viewState'

interface GitDiffChange {
  uri: vscode.Uri
  status: GitStatusValue
  insertions?: number
  deletions?: number
}

type GitRepository = GitRepositoryRef & {
  state: GitRepositoryRef['state'] & {
    HEAD?: { name?: string; commit?: string; ahead?: number; behind?: number }
    onDidChange: vscode.Event<void>
  }
  diffBetweenWithStats2?(ref: string, path?: string): Promise<GitDiffChange[]>
  diffIndexWithHEADShortStats?(path?: string): Promise<{ insertions: number; deletions: number }>
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
  private readonly syncingRoots = new Set<string>()
  /** `${rootPath}:${relativePath}` → diff stats for Changes-section badges */
  private readonly workingTreeStats = new Map<string, { insertions: number; deletions: number }>()
  private statsRefreshRoots = new Set<string>()
  private refreshTimer: ReturnType<typeof setTimeout> | undefined
  /** Last snapshot's rows, so expand/collapse does not walk the whole tree. */
  private readonly itemsById = new Map<string, RepoTreeItem>()
  private readonly repoCache = new Map<string, GitRepository | undefined>()
  private readonly changeIndex = new Map<string, Map<string, GitChange>>()
  private readonly resourceLetters = new Map<string, Map<string, string | undefined>>()
  private readonly mergedCache = new Map<string, MergedChangeFile[]>()
  private readonly mergedPersist = new Map<string, { sig: string; files: MergedChangeFile[] }>()
  private readonly nestedPersist = new Map<string, { sig: string; levels: Map<string, NestedChangeNode[]> }>()

  constructor(private readonly getGit: () => GitApi | undefined) {}

  setSyncingRoot(rootPath: string): void {
    if (this.syncingRoots.has(rootPath)) {
      return
    }
    this.syncingRoots.add(rootPath)
    this.refresh()
  }

  clearSyncingRoot(rootPath: string): void {
    if (!this.syncingRoots.delete(rootPath)) {
      return
    }
    this.refresh()
  }

  isSyncingRoot(rootPath: string): boolean {
    return this.syncingRoots.has(rootPath)
  }

  setViewOptions(options: ViewOptions): void {
    this.viewOptions = options
    this.refresh()
  }

  getViewOptions(): ViewOptions {
    return this.viewOptions
  }

  refresh(): void {
    this.cancelScheduledRefresh()
    this._onDidChangeTreeData.fire(undefined)
  }

  /** Coalesce git status bursts. The callback reads the latest repo state. */
  scheduleRefresh(): void {
    if (this.refreshTimer !== undefined) {
      return
    }
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined
      this._onDidChangeTreeData.fire(undefined)
    }, 50)
  }

  private cancelScheduledRefresh(): void {
    if (this.refreshTimer !== undefined) {
      clearTimeout(this.refreshTimer)
      this.refreshTimer = undefined
    }
  }

  findItemById(id: string): RepoTreeItem | undefined {
    const hit = this.itemsById.get(id)
    if (hit) {
      return hit
    }
    const walk = (items: RepoTreeItem[]): RepoTreeItem | undefined => {
      for (const item of items) {
        if (item.treeId === id) {
          return item
        }
        const found = walk(this.getChildren(item))
        if (found) {
          return found
        }
      }
      return undefined
    }
    return walk(this.getChildren())
  }

  buildSnapshot(): RepoSnap[] {
    this.beginSnapshot()
    return this.getChildren().map((item) => this.snapItem(item))
  }

  private beginSnapshot(): void {
    this.repoCache.clear()
    this.changeIndex.clear()
    this.resourceLetters.clear()
    this.mergedCache.clear()
    this.itemsById.clear()
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
        this.scheduleRefresh()
      }),
      api.onDidCloseRepository((repo) => {
        this.dropRepoCaches(repo.rootUri.fsPath)
        this.scheduleRefresh()
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
        this.scheduleWorkingTreeStats(repo.rootUri.fsPath)
        this.scheduleRefresh()
      })
    )
    this.touchWipActivity(repo)
    this.scheduleWorkingTreeStats(repo.rootUri.fsPath)
  }

  private scheduleWorkingTreeStats(rootPath: string): void {
    if (this.statsRefreshRoots.has(rootPath)) {
      return
    }
    this.statsRefreshRoots.add(rootPath)
    void this.refreshWorkingTreeStats(rootPath).finally(() => {
      this.statsRefreshRoots.delete(rootPath)
    })
  }

  private async refreshWorkingTreeStats(rootPath: string): Promise<void> {
    const git = this.git ?? this.getGit()
    const repo = git?.repositories.find((r) => r.rootUri.fsPath === rootPath) as GitRepository | undefined
    if (!repo?.diffBetweenWithStats2 || repo.state.workingTreeChanges.length === 0) {
      return
    }
    try {
      const changes = await repo.diffBetweenWithStats2('HEAD')
      const prefix = `${rootPath}:`
      for (const key of this.workingTreeStats.keys()) {
        if (key.startsWith(prefix)) {
          this.workingTreeStats.delete(key)
        }
      }
      for (const c of changes) {
        const rel = path.relative(rootPath, c.uri.fsPath).split(path.sep).join('/')
        if (!rel || rel.startsWith('..')) {
          continue
        }
        this.workingTreeStats.set(`${rootPath}:${rel}`, {
          insertions: c.insertions ?? 0,
          deletions: c.deletions ?? 0,
        })
      }
      this.scheduleRefresh()
    } catch {
      // diff stats are optional decoration
    }
  }

  private dropRepoCaches(rootPath: string): void {
    this.mergedPersist.delete(rootPath)
    const prefix = `${rootPath}\0`
    for (const key of this.nestedPersist.keys()) {
      if (key.startsWith(prefix)) {
        this.nestedPersist.delete(key)
      }
    }
    const statsPrefix = `${rootPath}:`
    for (const key of this.workingTreeStats.keys()) {
      if (key.startsWith(statsPrefix)) {
        this.workingTreeStats.delete(key)
      }
    }
  }

  private repoFor(rootPath: string): GitRepository | undefined {
    if (this.repoCache.has(rootPath)) {
      return this.repoCache.get(rootPath)
    }
    const git = this.git ?? this.getGit()
    const repo = git ? (findGitRepository(git, rootPath) as GitRepository | undefined) : undefined
    this.repoCache.set(rootPath, repo)
    return repo
  }

  private cachedChange(rootPath: string, section: ScmSection, relativePath: string): GitChange | undefined {
    const key = `${rootPath}\0${section}`
    let index = this.changeIndex.get(key)
    if (!index) {
      const repo = this.repoFor(rootPath)
      index = repo
        ? indexSectionChanges(rootPath, section, {
            index: repo.state.indexChanges,
            working: repo.state.workingTreeChanges,
            merge: repo.state.mergeChanges,
            untracked: repo.state.untrackedChanges ?? [],
          })
        : new Map()
      this.changeIndex.set(key, index)
    }
    return index.get(relativePath)
  }

  private statsForFile(rootPath: string, relativePath: string): { insertions: number; deletions: number } | undefined {
    return this.workingTreeStats.get(`${rootPath}:${relativePath}`)
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
    this.cancelScheduledRefresh()
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
    let i = 0
    while (i < queue.length) {
      const item = queue[i++]
      if (seen.has(item.treeId)) {
        continue
      }
      seen.add(item.treeId)
      if (item.collapsibleState !== vscode.TreeItemCollapsibleState.None) {
        this.expansion.markExpanded(item.treeId)
      }
      this.enqueueCollapsibleChildren(item, queue)
    }
  }

  /** Queue folders and sections. File rows are leaves and are not materialized here. */
  private enqueueCollapsibleChildren(item: RepoTreeItem, queue: RepoTreeItem[]): void {
    const node = item.node
    if (node.kind === 'scmSection' || node.kind === 'scmChangeDir') {
      const relativeDir = node.kind === 'scmChangeDir' ? node.relativeDir : ''
      for (const child of this.nodesAtDir(node.rootPath, node.section, relativeDir)) {
        if (child.kind === 'dir') {
          queue.push(this.nestedToItem(child, node.rootPath, node.section, item.treeId))
        }
      }
      return
    }
    if (node.kind === 'scmFile') {
      return
    }
    for (const child of this.getChildren(item)) {
      if (child.collapsibleState !== vscode.TreeItemCollapsibleState.None) {
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

    const change = repo ? findChangeForSection(repo, node.relativePath, node.section) : undefined
    if (change?.status !== undefined) {
      const stats = node.section === 'changes' ? this.statsForFile(node.rootPath, node.relativePath) : undefined
      item.description = formatStatusBadge(change.status, stats?.insertions, stats?.deletions)
    } else {
      const resource = repo ? findScmResourceForFile(repo, node.relativePath, node.section) : undefined
      if (resource?.letter) {
        item.description = resource.letter
      }
      if (resource?.tooltip) {
        item.tooltip = resource.tooltip
      }
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
        return this.changeItemsForSection(node.rootPath, node.section, treeId, '')
      }
      if (node.kind === 'scmChangeDir') {
        return this.changeItemsForSection(node.rootPath, node.section, treeId, node.relativeDir)
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

    const workspaceFolders =
      vscode.workspace.workspaceFolders?.map((f, order) => ({
        fsPath: f.uri.fsPath,
        name: f.name,
        order,
      })) ?? []

    let roots = buildRepositoryTree(
      git.repositories.map((r) => ({ rootPath: r.rootUri.fsPath })),
      { workspaceFolders }
    )

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

  private mergedForRepo(rootPath: string, git: GitApi): MergedChangeFile[] {
    const hit = this.mergedCache.get(rootPath)
    if (hit) {
      return hit
    }
    const repo = (findGitRepository(git, rootPath) as GitRepository | undefined) ?? this.repoFor(rootPath)
    if (!repo) {
      this.mergedCache.set(rootPath, [])
      return []
    }
    const sig = [
      pathListSignature(repo.state.indexChanges.map((c) => c.uri.fsPath)),
      pathListSignature(repo.state.workingTreeChanges.map((c) => c.uri.fsPath)),
      pathListSignature(repo.state.mergeChanges.map((c) => c.uri.fsPath)),
      pathListSignature((repo.state.untrackedChanges ?? []).map((c) => c.uri.fsPath)),
    ].join('|')
    const prev = this.mergedPersist.get(rootPath)
    if (prev && prev.sig === sig) {
      this.mergedCache.set(rootPath, prev.files)
      return prev.files
    }
    const files = mergeRepoChanges(
      repo.rootUri.fsPath,
      repo.state.indexChanges,
      repo.state.workingTreeChanges,
      repo.state.mergeChanges,
      repo.state.untrackedChanges ?? []
    )
    this.mergedPersist.set(rootPath, { sig, files })
    this.mergedCache.set(rootPath, files)
    return files
  }

  private nodesAtDir(rootPath: string, section: ScmSection, relativeDir: string): NestedChangeNode[] {
    const git = this.git ?? this.getGit()
    if (!git) {
      return []
    }
    const layout = this.viewOptions.layout
    const key = `${rootPath}\0${section}\0${layout}`
    const files = filesForSection(this.mergedForRepo(rootPath, git), section)
    const sig = pathListSignature(files.map((f) => f.relativePath))
    const prev = this.nestedPersist.get(key)
    const levels =
      prev && prev.sig === sig
        ? prev.levels
        : nestedDirChildren(nestChangePaths(files, layout === 'flat'))
    if (!prev || prev.sig !== sig) {
      this.nestedPersist.set(key, { sig, levels })
    }
    return levels.get(relativeDir) ?? []
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
          this.expansion.collapsibleState(treeId, true, scmSectionExpandFallback(section))
        )
      }
    )
  }

  private changeItemsForSection(
    rootPath: string,
    section: ScmSection,
    parentTreeId: string,
    relativeDir: string
  ): RepoTreeItem[] {
    return this.nodesAtDir(rootPath, section, relativeDir).map((n) =>
      this.nestedToItem(n, rootPath, section, parentTreeId)
    )
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
      this.expansion.collapsibleState(treeId, hasChildren, scmChangeDirExpandFallback())
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

  private snapItem(item: RepoTreeItem): RepoSnap {
    this.itemsById.set(item.treeId, item)
    const node = item.node
    const hasChildren = item.collapsibleState !== vscode.TreeItemCollapsibleState.None
    const expanded = item.collapsibleState === vscode.TreeItemCollapsibleState.Expanded
    let children: RepoSnap[] = []
    if (expanded && (node.kind === 'scmSection' || node.kind === 'scmChangeDir')) {
      const relativeDir = node.kind === 'scmChangeDir' ? node.relativeDir : ''
      children = this.nodesAtDir(node.rootPath, node.section, relativeDir).map((child) =>
        this.snapNested(child, node.rootPath, node.section, item.treeId)
      )
    } else if (expanded) {
      children = this.getChildren(item).map((child) => this.snapItem(child))
    }
    const kind: RepoSnap['kind'] =
      node.kind === 'scmSection'
        ? 'section'
        : node.kind === 'scmChangeDir'
          ? 'dir'
          : node.kind === 'scmFile'
            ? 'file'
            : node.kind
    const rootPath = nodeRootPath(node)
    const isDirty = (p: string) => {
      const git = this.git ?? this.getGit()
      const repo = git ? findGitRepository(git, p) : undefined
      return repo ? repoHasWorkingChanges(statusFromRepo(repo)) : false
    }
    const snap: RepoSnap = {
      id: item.treeId,
      kind,
      name: node.name,
      expanded: item.collapsibleState === vscode.TreeItemCollapsibleState.Expanded,
      hasChildren,
      dirty: node.kind === 'repo' || node.kind === 'folder' ? treeHasDirtyRepo(node, isDirty) : false,
      rootPath,
      children,
    }
    if (node.kind === 'scmSection' || node.kind === 'scmChangeDir' || node.kind === 'scmFile') {
      snap.section = node.section
    }
    if (node.kind === 'scmChangeDir') {
      snap.relativeDir = node.relativeDir
    }
    if (node.kind === 'scmFile') {
      this.applyFileBadge(snap, node.rootPath, node.section, node.relativePath)
    }
    if (rootPath && (node.kind === 'repo' || node.kind === 'folder')) {
      snap.syncing = this.isSyncingRoot(rootPath)
      const git = this.git ?? this.getGit()
      const repo = git?.repositories.find((r) => r.rootUri.fsPath === rootPath)
      const head = repo?.state.HEAD
      if (head?.name) {
        snap.branch = head.name
      } else if (head?.commit) {
        snap.branch = head.commit.slice(0, 7)
      }
      snap.ahead = head?.ahead
      snap.behind = head?.behind
    }
    return snap
  }

  private snapNested(
    node: NestedChangeNode,
    rootPath: string,
    section: ScmSection,
    parentTreeId: string
  ): RepoSnap {
    if (node.kind === 'file') {
      const treeNode: RepoTreeNode = {
        kind: 'scmFile',
        rootPath,
        section,
        relativePath: node.relativePath,
        name: node.name,
      }
      const snap: RepoSnap = {
        id: stableNodeId(treeNode, parentTreeId),
        kind: 'file',
        name: node.name,
        expanded: false,
        hasChildren: false,
        dirty: true,
        rootPath,
        section,
        relativePath: node.relativePath,
        children: [],
      }
      this.applyFileBadge(snap, rootPath, section, node.relativePath)
      return snap
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
    const collapsible = this.expansion.collapsibleState(treeId, hasChildren, scmChangeDirExpandFallback())
    const item = new RepoTreeItem(treeNode, treeId, collapsible)
    this.itemsById.set(treeId, item)
    const expanded = collapsible === vscode.TreeItemCollapsibleState.Expanded
    return {
      id: treeId,
      kind: 'dir',
      name: node.name,
      expanded,
      hasChildren,
      dirty: false,
      rootPath,
      section,
      relativeDir: node.relativeDir,
      children: expanded
        ? node.children.map((child) => this.snapNested(child, rootPath, section, treeId))
        : [],
    }
  }

  private applyFileBadge(snap: RepoSnap, rootPath: string, section: ScmSection, relativePath: string): void {
    snap.dirty = true
    snap.relativePath = relativePath
    snap.section = section
    const change = this.cachedChange(rootPath, section, relativePath)
    if (change?.status !== undefined) {
      const stats = section === 'changes' ? this.statsForFile(rootPath, relativePath) : undefined
      snap.letter = formatStatusBadge(change.status, stats?.insertions, stats?.deletions)
      snap.statusClass = statusCssClass(change.status)
      return
    }
    snap.letter = this.letterFromResources(rootPath, section, relativePath)
  }

  /** One scan of the SCM resource groups, then O(1) lookups for the rest of the snapshot. */
  private letterFromResources(rootPath: string, section: ScmSection, relativePath: string): string | undefined {
    const key = `${rootPath}\0${section}`
    let index = this.resourceLetters.get(key)
    if (!index) {
      index = new Map()
      const repo = this.repoFor(rootPath)
      const groups =
        section === 'staged'
          ? [repo?.indexGroup]
          : section === 'merge'
            ? [repo?.mergeGroup]
            : [repo?.untrackedGroup, repo?.workingTreeGroup]
      for (const group of groups) {
        for (const resource of group?.resourceStates ?? []) {
          index.set(relativeRepoPath(rootPath, resource.resourceUri.fsPath), resource.letter)
        }
      }
      this.resourceLetters.set(key, index)
    }
    return index.get(relativePath)
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

async function syncSelectionContext(
  tree: vscode.TreeView<RepoTreeItem>,
  provider: RepositoryTreeProvider
): Promise<void> {
  const selected = tree.selection[0]
  const kind = selected ? selectionKindFromNode(selected.node) : 'none'
  await vscode.commands.executeCommand('setContext', 'repoTree.selectionKind', kind)
  const rootPath = selected ? nodeRootPath(selected.node) : undefined
  await vscode.commands.executeCommand(
    'setContext',
    'repoTree.repoSyncing',
    Boolean(rootPath && provider.isSyncingRoot(rootPath))
  )
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
      repo.state.mergeChanges,
      repo.state.untrackedChanges ?? []
    ),
    'staged'
  )
}

async function runGitSync(provider: RepositoryTreeProvider, rootPath?: string): Promise<void> {
  if (!rootPath || provider.isSyncingRoot(rootPath)) {
    return
  }
  provider.setSyncingRoot(rootPath)
  try {
    await runGitRepoCommand(getGitApi, 'git.sync', undefined, rootPath)
  } finally {
    provider.clearSyncingRoot(rootPath)
  }
}

async function runStageWithReveal(
  provider: RepositoryTreeProvider,
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
}

function scmFileFromItem(
  item?: RepoTreeItem
): Extract<RepoTreeNode, { kind: 'scmFile' }> | undefined {
  if (item?.node.kind === 'scmFile') {
    return item.node
  }
  return undefined
}

function scmChangeDirFromItem(
  item?: RepoTreeItem
): Extract<RepoTreeNode, { kind: 'scmChangeDir' }> | undefined {
  if (item?.node.kind === 'scmChangeDir') {
    return item.node
  }
  return undefined
}

function scmSectionFromItem(
  item?: RepoTreeItem
): Extract<RepoTreeNode, { kind: 'scmSection' }> | undefined {
  if (item?.node.kind === 'scmSection') {
    return item.node
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
  item?: RepoTreeItem
): { rootPath: string; section: ScmSection; relativeDir: string } | undefined {
  const section = scmSectionFromItem(item)
  if (section) {
    return { rootPath: section.rootPath, section: section.section, relativeDir: '' }
  }
  const dir = scmChangeDirFromItem(item)
  if (dir) {
    return { rootPath: dir.rootPath, section: dir.section, relativeDir: dir.relativeDir }
  }
  return undefined
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const stored = loadViewOptions(context.globalState.get<Partial<ViewOptions>>(STORAGE_KEY))
  await syncViewContext(stored)
  await vscode.commands.executeCommand('setContext', 'repoTree.selectionKind', 'none')
  await vscode.commands.executeCommand('setContext', 'repoTree.repoSyncing', false)

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

  const graphAvailable = (): { gitGraph: boolean; gitLens: boolean } => ({
    gitGraph: !!vscode.extensions.getExtension('mhutchie.git-graph'),
    gitLens: !!vscode.extensions.getExtension('eamodio.gitlens'),
  })

  const webview = new RepoWebviewViewProvider(
    () => ({
      options: provider.getViewOptions(),
      nodes: provider.buildSnapshot(),
      ...graphAvailable(),
    }),
    async (message: RepoViewMessage) => {
      if (message.type === 'toggle') {
        const item = provider.findItemById(message.id)
        if (!item || item.collapsibleState === vscode.TreeItemCollapsibleState.None) {
          return
        }
        const expanded = item.collapsibleState === vscode.TreeItemCollapsibleState.Expanded
        provider.expansion.recordExpanded(item.treeId, !expanded)
        const repoRoot = nodeRootPath(item.node)
        if (!expanded && repoRoot && !provider.expansion.hasRepoOpenedInSession(repoRoot)) {
          provider.expansion.markRepoOpenedInSession(repoRoot)
          const opened = provider.findItemById(message.id)
          if (opened) {
            provider.seedSubtreeExpanded(opened)
          }
        }
        provider.refresh()
        return
      }
      if (message.type !== 'action' || !message.rootPath) {
        return
      }
      const rootPath = message.rootPath
      const section = message.section
      const relativePath = message.relativePath
      const relativeDir = message.relativeDir ?? ''
      const fileNode: RepoTreeNode | undefined =
        section && relativePath
          ? { kind: 'scmFile', rootPath, section, relativePath, name: path.basename(relativePath) }
          : undefined
      switch (message.action) {
        case 'checkout':
          await runGitRepoCommand(getGitApi, 'git.checkout', undefined, rootPath)
          break
        case 'sync':
          await runGitSync(provider, rootPath)
          break
        case 'commit':
          await commitRepository(getGitApi, rootPath)
          break
        case 'refresh':
          await runGitRepoCommand(getGitApi, 'git.refresh', undefined, rootPath)
          break
        case 'pull':
          await runGitRepoCommand(getGitApi, 'git.pull', undefined, rootPath)
          break
        case 'push':
          await runGitRepoCommand(getGitApi, 'git.push', undefined, rootPath)
          break
        case 'reveal':
          await vscode.commands.executeCommand(
            'revealInExplorer',
            vscode.Uri.file(relativePath ? path.join(rootPath, relativePath) : rootPath)
          )
          break
        case 'openWindow':
          await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(rootPath), {
            forceNewWindow: true,
          })
          break
        case 'gitGraph':
          await vscode.commands.executeCommand('git-graph.view', { rootUri: vscode.Uri.file(rootPath) })
          break
        case 'gitLens':
          await vscode.commands.executeCommand('gitlens.showGraph', { rootUri: vscode.Uri.file(rootPath) })
          break
        case 'openDiff':
          if (fileNode) {
            await openChangeDiff(getGitApi, { node: fileNode })
          }
          break
        case 'openFile':
          if (fileNode) {
            await openChangeFile(getGitApi, { node: fileNode })
          }
          break
        case 'stage':
          if (section && section !== 'staged' && relativePath) {
            await runStageWithReveal(provider, rootPath, [relativePath], section)
          }
          break
        case 'unstage':
          if (relativePath) {
            await unstagePaths(getGitApi, rootPath, [relativePath])
          }
          break
        case 'discard':
        case 'revert':
          if (section === 'staged' || section === 'changes') {
            const revertTargets = relativePath
              ? [relativePath]
              : pathsInSection(getGitApi, rootPath, section, relativeDir)
            await revertPaths(getGitApi, rootPath, revertTargets, section)
          }
          break
        case 'stageAll':
          if (section && section !== 'staged') {
            await runStageWithReveal(
              provider,
              rootPath,
              pathsInSection(getGitApi, rootPath, section, relativeDir),
              section
            )
          }
          break
        case 'unstageAll':
          if (section === 'staged') {
            await unstagePaths(getGitApi, rootPath, pathsInSection(getGitApi, rootPath, section, relativeDir))
          }
          break
        case 'discardAll':
          if (section === 'changes' || section === 'staged') {
            await revertPaths(
              getGitApi,
              rootPath,
              pathsInSection(getGitApi, rootPath, section, relativeDir),
              section
            )
          }
          break
        default:
          break
      }
    }
  )
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('repoTree.repositories', webview, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    provider.onDidChangeTreeData(() => webview.postState()),
    provider
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

  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      provider.refresh()
    })
  )

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
    const rootPath = item ? nodeRootPath(item.node) : undefined
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
    vscode.commands.registerCommand('repoTree.gitSync', (item?: RepoTreeItem) => {
      void runGitSync(provider, item ? nodeRootPath(item.node) : undefined)
    }),
    vscode.commands.registerCommand('repoTree.gitSyncBusy', () => {
      // Spinning affordance only; sync runs via repoTree.gitSync.
    }),
    vscode.commands.registerCommand('repoTree.gitRefresh', (item?: RepoTreeItem) =>
      runGitRepoCommand(getGitApi, 'git.refresh', item)
    ),
    vscode.commands.registerCommand('repoTree.gitPull', (item?: RepoTreeItem) =>
      runGitRepoCommand(getGitApi, 'git.pull', item)
    ),
    vscode.commands.registerCommand('repoTree.gitPush', (item?: RepoTreeItem) =>
      runGitRepoCommand(getGitApi, 'git.push', item)
    ),
    vscode.commands.registerCommand('repoTree.commit', (item?: RepoTreeItem) => {
      const rootPath = item ? nodeRootPath(item.node) : undefined
      if (!rootPath) {
        return
      }
      void commitRepository(getGitApi, rootPath)
    }),
    vscode.commands.registerCommand('repoTree.stageFile', (item?: RepoTreeItem) => {
      const file = scmFileFromItem(item)
      if (!file || (file.section !== 'changes' && file.section !== 'merge')) {
        return
      }
      void runStageWithReveal(provider, file.rootPath, [file.relativePath], file.section)
    }),
    vscode.commands.registerCommand('repoTree.unstageFile', (item?: RepoTreeItem) => {
      const file = scmFileFromItem(item)
      if (!file || file.section !== 'staged') {
        return
      }
      void unstagePaths(getGitApi, file.rootPath, [file.relativePath])
    }),
    vscode.commands.registerCommand('repoTree.discardFile', (item?: RepoTreeItem) => {
      const file = scmFileFromItem(item)
      if (!file || file.section !== 'changes') {
        return
      }
      void discardPaths(getGitApi, file.rootPath, [file.relativePath])
    }),
    vscode.commands.registerCommand('repoTree.stageAllInScope', (item?: RepoTreeItem) => {
      const scope = sectionScopeFromItem(item)
      if (!scope || scope.section === 'staged') {
        return
      }
      const paths = pathsInSection(getGitApi, scope.rootPath, scope.section, scope.relativeDir)
      void runStageWithReveal(provider, scope.rootPath, paths, scope.section)
    }),
    vscode.commands.registerCommand('repoTree.unstageAllInScope', (item?: RepoTreeItem) => {
      const scope = sectionScopeFromItem(item)
      if (!scope || scope.section !== 'staged') {
        return
      }
      const paths = pathsInSection(getGitApi, scope.rootPath, scope.section, scope.relativeDir)
      void unstagePaths(getGitApi, scope.rootPath, paths)
    }),
    vscode.commands.registerCommand('repoTree.discardAllInScope', (item?: RepoTreeItem) => {
      const scope = sectionScopeFromItem(item)
      if (!scope || scope.section !== 'changes') {
        return
      }
      const paths = pathsInSection(getGitApi, scope.rootPath, scope.section, scope.relativeDir)
      void discardPaths(getGitApi, scope.rootPath, paths)
    }),
    vscode.commands.registerCommand('repoTree.addToGitignore', (item?: RepoTreeItem) => {
      void addPathToGitignore(item)
    }),
    vscode.commands.registerCommand('repoTree.viewGitGraph', (item?: RepoTreeItem) => {
      void openRepoGraph('git-graph.view', item)
    }),
    vscode.commands.registerCommand('repoTree.viewCommitGraph', (item?: RepoTreeItem) => {
      void openRepoGraph('gitlens.showGraph', item)
    }),
    vscode.commands.registerCommand('repoTree.openInNewWindow', async (item?: RepoTreeItem) => {
      const rootPath = item ? nodeRootPath(item.node) : undefined
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

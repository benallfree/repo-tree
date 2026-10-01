import * as vscode from 'vscode'
import type { ViewOptions } from './viewState'
import type { ScmSection } from './scmTree'

export interface RepoSnap {
  id: string
  kind: 'repo' | 'folder' | 'section' | 'dir' | 'file'
  name: string
  expanded: boolean
  hasChildren: boolean
  dirty: boolean
  rootPath?: string
  section?: ScmSection
  relativePath?: string
  relativeDir?: string
  branch?: string
  ahead?: number
  behind?: number
  syncing?: boolean
  letter?: string
  children: RepoSnap[]
}

export interface RepoViewState {
  options: ViewOptions
  nodes: RepoSnap[]
  gitGraph: boolean
  gitLens: boolean
}

export type RepoViewMessage =
  | { type: 'toggle'; id: string }
  | {
      type: 'action'
      action: string
      rootPath?: string
      section?: ScmSection
      relativePath?: string
      relativeDir?: string
    }

export class RepoWebviewViewProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView

  constructor(
    private readonly getState: () => RepoViewState,
    private readonly handle: (message: RepoViewMessage) => void | Promise<void>
  ) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView
    webviewView.webview.options = { enableScripts: true }
    webviewView.webview.onDidReceiveMessage((message: RepoViewMessage) => {
      void this.handle(message)
    })
    webviewView.webview.html = html()
    this.postState()
  }

  postState(): void {
    this.view?.webview.postMessage({ type: 'state', state: this.getState() })
  }
}

function html(): string {
  const nonce = String(Date.now())
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
<style>
  body {
    margin: 0;
    padding: 0 0 8px;
    color: var(--vscode-foreground);
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    background: transparent;
  }
  .row {
    display: flex;
    align-items: center;
    height: 22px;
    padding-right: 6px;
    gap: 2px;
  }
  .row:hover { background: var(--vscode-list-hoverBackground); }
  .main {
    display: flex;
    align-items: center;
    min-width: 0;
    flex: 1;
    gap: 4px;
  }
  .name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .name.dirty { color: var(--vscode-gitDecoration-modifiedResourceForeground); }
  .name.clickable, .main.clickable { cursor: pointer; }
  .actions {
    display: flex;
    align-items: center;
    flex: none;
    gap: 0;
  }
  .branch {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    margin-right: 6px;
    opacity: 0.9;
    font-size: 12px;
    white-space: nowrap;
  }
  .counts {
    font-size: 11px;
    margin-right: 2px;
    opacity: 0.95;
    font-variant-numeric: tabular-nums;
  }
  button.icon {
    width: 22px;
    height: 22px;
    padding: 0;
    border: 0;
    background: transparent;
    color: var(--vscode-icon-foreground);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    border-radius: 3px;
  }
  button.icon:hover { background: var(--vscode-toolbar-hoverBackground); }
  button.chevron { color: var(--vscode-foreground); opacity: 0.8; }
  button.chevron.empty { visibility: hidden; }
  .letter {
    width: 16px;
    text-align: center;
    opacity: 0.7;
    font-size: 11px;
  }
  .menu {
    position: fixed;
    z-index: 5;
    min-width: 180px;
    padding: 4px 0;
    background: var(--vscode-menu-background);
    color: var(--vscode-menu-foreground);
    border: 1px solid var(--vscode-menu-border, transparent);
    box-shadow: 0 2px 8px rgba(0,0,0,.36);
  }
  .menu button {
    display: block;
    width: 100%;
    text-align: left;
    background: transparent;
    color: inherit;
    border: 0;
    padding: 4px 12px;
    cursor: pointer;
    font: inherit;
  }
  .menu button:hover { background: var(--vscode-menu-selectionBackground); color: var(--vscode-menu-selectionForeground); }
  .empty {
    padding: 12px;
    opacity: 0.8;
  }
  svg { width: 16px; height: 16px; display: block; }
  .spin { animation: spin 1s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
</style>
</head>
<body>
<div id="root"></div>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi()
const I = {
  chevron: '<svg viewBox="0 0 16 16"><path fill="currentColor" d="M6 4l4 4-4 4V4z"/></svg>',
  folder: '<svg viewBox="0 0 16 16"><path fill="currentColor" d="M1.5 3h4l1 1.5h8v8.5h-13V3z"/></svg>',
  repo: '<svg viewBox="0 0 16 16"><path fill="currentColor" d="M2 2h5v5H2V2zm7 0h5v5H9V2zM2 9h5v5H2V9zm7 0h5v5H9V9z"/></svg>',
  branch: '<svg viewBox="0 0 16 16"><path fill="currentColor" d="M4 2.5a1.5 1.5 0 100 3 1.5 1.5 0 000-3zM2.5 4v5.2A2.3 2.3 0 004.8 11.5H8V10H4.8A.8.8 0 014 9.2V4h-1.5zM11.5 2.5a1.5 1.5 0 110 3 1.5 1.5 0 010-3zM12 6.5V9h1.5V6.5h-1.5zM11.5 10.5a1.5 1.5 0 100 3 1.5 1.5 0 000-3z"/></svg>',
  sync: '<svg viewBox="0 0 16 16"><path fill="currentColor" d="M13.5 3.5A6 6 0 003.2 6H1.5L4 8.5 6.5 6H4.7a4.5 4.5 0 117.3 3.4l1.1 1.1a6 6 0 00.4-7zM2.5 12.5A6 6 0 0012.8 10H14.5L12 7.5 9.5 10h1.8a4.5 4.5 0 11-7.3-3.4L2.9 5.5a6 6 0 00-.4 7z"/></svg>',
  check: '<svg viewBox="0 0 16 16"><path fill="currentColor" d="M6.2 11.4L2.8 8l1.1-1.1 2.3 2.3 5.9-5.9L13.2 4.4 6.2 11.4z"/></svg>',
  refresh: '<svg viewBox="0 0 16 16"><path fill="currentColor" d="M13.5 8a5.5 5.5 0 11-1.4-3.7L10.5 6H15V1.5L13.2 3.3A7 7 0 1014.9 8h-1.4z"/></svg>',
  graph: '<svg viewBox="0 0 16 16"><path fill="currentColor" d="M3 12h2V8H3v4zm4 0h2V4H7v8zm4 0h2V6h-2v6z"/></svg>',
  more: '<svg viewBox="0 0 16 16"><circle cx="3" cy="8" r="1.2" fill="currentColor"/><circle cx="8" cy="8" r="1.2" fill="currentColor"/><circle cx="13" cy="8" r="1.2" fill="currentColor"/></svg>',
  add: '<svg viewBox="0 0 16 16"><path fill="currentColor" d="M7.2 2h1.6v5.2H14v1.6H8.8V14H7.2V8.8H2V7.2h5.2V2z"/></svg>',
  discard: '<svg viewBox="0 0 16 16"><path fill="currentColor" d="M3 3h7l3 3v7H3V3zm6.2 1.2V6H12L9.2 4.2zM4.5 8.5l2 2 5-5 1 1-6 6-3-3 1-1z"/></svg>',
  remove: '<svg viewBox="0 0 16 16"><path fill="currentColor" d="M3 7.2h10v1.6H3z"/></svg>'
}

let menu
function closeMenu() {
  if (menu) menu.remove()
  menu = undefined
}
document.addEventListener('click', closeMenu)

function btn(icon, label, action, extra) {
  const b = document.createElement('button')
  b.className = 'icon' + (extra || '')
  b.title = label
  b.setAttribute('aria-label', label)
  b.innerHTML = icon
  b.addEventListener('click', (e) => {
    e.stopPropagation()
    action(e)
  })
  return b
}

function counts(node) {
  const ahead = node.ahead || 0
  const behind = node.behind || 0
  if (!ahead && !behind) return ''
  return behind + '↓ ' + ahead + '↑'
}

function render(state) {
  const root = document.getElementById('root')
  const scroll = document.scrollingElement ? document.scrollingElement.scrollTop : 0
  root.textContent = ''
  if (!state.nodes.length) {
    const p = document.createElement('div')
    p.className = 'empty'
    p.textContent = 'No repositories in this workspace.'
    root.appendChild(p)
    return
  }
  const walk = (nodes, depth) => {
    for (const node of nodes) {
      root.appendChild(row(node, depth, state))
      if (node.expanded && node.children.length) walk(node.children, depth + 1)
    }
  }
  walk(state.nodes, 0)
  if (document.scrollingElement) document.scrollingElement.scrollTop = scroll
}

function row(node, depth, state) {
  const el = document.createElement('div')
  el.className = 'row'
  el.style.paddingLeft = (4 + depth * 12) + 'px'

  const main = document.createElement('div')
  main.className = 'main'
  const chevron = btn(I.chevron, node.expanded ? 'Collapse' : 'Expand', () => {
    vscode.postMessage({ type: 'toggle', id: node.id })
  }, ' chevron')
  if (!node.hasChildren) chevron.classList.add('empty')
  if (node.expanded) chevron.style.transform = 'rotate(90deg)'
  main.appendChild(chevron)
  const glyph = document.createElement('span')
  glyph.innerHTML = node.kind === 'folder' || node.kind === 'dir' || node.kind === 'section' ? I.folder : (node.kind === 'repo' ? I.repo : '')
  if (node.kind !== 'file') main.appendChild(glyph)
  const name = document.createElement('span')
  name.className = 'name' + (node.dirty ? ' dirty' : '')
  name.textContent = node.name
  if (node.kind === 'file') {
    name.classList.add('clickable')
    name.addEventListener('click', (e) => {
      e.stopPropagation()
      postAction('openDiff', node)
    })
  }
  main.appendChild(name)
  if (node.hasChildren && (node.kind === 'folder' || node.kind === 'dir' || node.kind === 'section')) {
    main.classList.add('clickable')
    main.addEventListener('click', () => {
      vscode.postMessage({ type: 'toggle', id: node.id })
    })
  }
  el.appendChild(main)

  const actions = document.createElement('div')
  actions.className = 'actions'
  if (node.kind === 'repo' && node.rootPath) {
    const branch = document.createElement('span')
    branch.className = 'branch'
    branch.innerHTML = I.branch
    const label = document.createElement('span')
    label.textContent = node.branch || ''
    branch.appendChild(label)
    actions.appendChild(branch)
    const c = counts(node)
    if (c) {
      const span = document.createElement('span')
      span.className = 'counts'
      span.textContent = c
      actions.appendChild(span)
    }
    const syncIcon = node.syncing ? I.sync : I.sync
    const syncBtn = btn(syncIcon, 'Sync', () => postAction('sync', node))
    if (node.syncing) syncBtn.querySelector('svg').classList.add('spin')
    actions.appendChild(syncBtn)
    actions.appendChild(btn(I.check, 'Commit', () => postAction('commit', node)))
    actions.appendChild(btn(I.refresh, 'Refresh', () => postAction('refresh', node)))
    if (state.gitLens) actions.appendChild(btn(I.graph, 'Show Commit Graph', () => postAction('gitLens', node)))
    else if (state.gitGraph) actions.appendChild(btn(I.graph, 'View Git Graph', () => postAction('gitGraph', node)))
    actions.appendChild(btn(I.more, 'More Actions', (e) => openMenu(e, node)))
  } else if (node.kind === 'file') {
    if (node.letter) {
      const letter = document.createElement('span')
      letter.className = 'letter'
      letter.textContent = node.letter
      actions.appendChild(letter)
    }
    if (node.section === 'staged') {
      actions.appendChild(btn(I.remove, 'Unstage', () => postAction('unstage', node)))
    } else if (node.section === 'changes') {
      actions.appendChild(btn(I.add, 'Stage', () => postAction('stage', node)))
      actions.appendChild(btn(I.discard, 'Discard', () => postAction('discard', node)))
    } else if (node.section === 'merge') {
      actions.appendChild(btn(I.add, 'Stage', () => postAction('stage', node)))
    }
  } else if (node.kind === 'section' || node.kind === 'dir') {
    if (node.section === 'staged') {
      actions.appendChild(btn(I.remove, 'Unstage All', () => postAction('unstageAll', node)))
    } else if (node.section === 'changes') {
      actions.appendChild(btn(I.add, 'Stage All', () => postAction('stageAll', node)))
      actions.appendChild(btn(I.discard, 'Discard All', () => postAction('discardAll', node)))
    } else if (node.section === 'merge') {
      actions.appendChild(btn(I.add, 'Stage All', () => postAction('stageAll', node)))
    }
  }
  el.appendChild(actions)
  return el
}

function postAction(action, node) {
  vscode.postMessage({
    type: 'action',
    action,
    rootPath: node.rootPath,
    section: node.section,
    relativePath: node.relativePath,
    relativeDir: node.relativeDir
  })
}

function openMenu(event, node) {
  closeMenu()
  const m = document.createElement('div')
  m.className = 'menu'
  const add = (label, action) => {
    const b = document.createElement('button')
    b.textContent = label
    b.addEventListener('click', (e) => {
      e.stopPropagation()
      closeMenu()
      postAction(action, node)
    })
    m.appendChild(b)
  }
  add('Pull', 'pull')
  add('Push', 'push')
  add('Reveal in Explorer', 'reveal')
  add('Open in New Window', 'openWindow')
  document.body.appendChild(m)
  const rect = event.currentTarget.getBoundingClientRect()
  m.style.top = rect.bottom + 'px'
  m.style.left = Math.max(8, rect.right - 180) + 'px'
  menu = m
  event.stopPropagation()
}

window.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'state') render(event.data.state)
})
vscode.postMessage({ type: 'ready' })
</script>
</body>
</html>`
}

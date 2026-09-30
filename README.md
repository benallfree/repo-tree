# Repository Tree

Cursor/VS Code extension: a **Repository Tree** view in the Source Control sidebar. Open git repositories (including worktrees and submodules) are grouped by folder path instead of a flat list.

## Develop

```bash
npm install
npm test
npm run compile
```

Open this folder in Cursor, run **Run Extension** (`.vscode/launch.json`). The Extension Development Host opens `root.code-workspace`.

## Install locally

```bash
./scripts/install.sh
```

Reload the window. The script symlinks this repo into `~/.cursor/extensions/benallfree.repo-tree-<version>`.

Hide the built-in **Repositories** section from Source Control → `...` → Views if you only want the tree.

### View toolbar

| Control | Action |
| --- | --- |
| Tree / flat | Toggle nested folders vs a single sorted list |
| Sort | Name, or recent WIP (last dirty activity in this window) |
| Filter | Hide clean repos; tree mode keeps parent folders |

For inline **Revert** on changed file and path-folder rows, set `"scm.alwaysShowActions": true` in settings.

### Dirty repos

Expand a dirty repo to see changed files nested by path (no Staged/Changes section headers). Expanding a repo opens the full change subtree. Click a changed file row to open the diff (`git.openChange`). The go-to-file icon opens the working copy in the editor. **Revert** on a file or folder unstages and discards back to HEAD (including untracked under that path). Repo rows keep sync, pull, and push.

If [Git Graph](https://marketplace.visualstudio.com/items?itemName=mhutchie.git-graph) or GitLens is installed, the same hover graph action that **Changes** shows on each repository appears on the repo row (**View Git Graph** / **Show Commit Graph**).

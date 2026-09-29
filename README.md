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

Click a dirty repo to expand nested changed files (path folders in tree layout). Click a changed file to open its diff; use the go-to-file icon to open the working copy. Inline stage, unstage, and discard on file rows. Stage All and Unstage All are on the repo context menu. Repo rows keep sync, pull, push, and commit without driving the built-in Changes list.

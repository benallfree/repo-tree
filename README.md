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

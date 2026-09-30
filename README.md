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
| Commit (check) | Shown when any repo has staged changes; commits using SCM input message or a prompt |

For file rows to show inline stage/unstage icons like built-in **Changes**, set `"scm.alwaysShowActions": true` in settings.

### Dirty repos

Expand a dirty repo to see changed files nested by path directly under that repo (no **Changes** group row). Expanding a repo opens the full change subtree. Click a file to open the same diff as **Changes** (`git.openChange`). Use the go-to-file icon for the working copy. Stage (+), unstage (−), and discard on file rows. **Stage All** / **Unstage All** are on the repo row. Repo rows keep sync, pull, push, and commit.

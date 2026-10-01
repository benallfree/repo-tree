# Changelog

All notable changes to **Repository Tree** are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Changed

- Repository Tree is a custom view. Repo rows show branch, ahead/behind counts, sync, commit, refresh, and more actions in a fixed cluster.

## [0.3.0] - 2026-10-01

### Added

- **Staged Changes**, **Changes**, and **Merge Changes** sections under each dirty repo, with path nesting inside each section (same path can appear in more than one section).
- **Stage**, **Unstage**, and **Discard** on files and folders; **Stage All**, **Unstage All**, and **Discard All** on sections and path folders. Discard uses a confirmation dialog and only resets the working tree (unstage is separate).
- **Commit** on the repo row (`showInputBox` + Git `commit`). If nothing is staged, commit includes all modified files (same as stock **Commit All**).
- **Repository Tree** panel toolbar actions driven by selection (commit, stage, discard, open diff, and related).
- Session **expand/collapse memory** per tree node; the first time you open a repo in a window, its full subtree expands.
- When **Staged Changes** first appears, that section opens expanded; path folders copy expand/collapse from **Changes** (or **Merge**).
- **Sync** shows a spinning icon on the syncing repo until `git.sync` finishes.
- Local **`./scripts/install.sh`** bumps a `-bN` build suffix in `package.json` and refreshes the Cursor symlink; counters in gitignored `.build-number` / `.build-base`.
- **`AGENTS.md`** and **local install** Cursor rule for agents.

### Changed

- Clearer errors when commit fails (empty index vs Git hook / identity issues).

### Removed

- **Revert** actions that combined unstage and discard in one step.

## [0.2.0] - 2026-09-30

### Added

- **Add to .gitignore** on a changed file or path folder. The repo `.gitignore` opens, the path is appended, and the file is saved so Git refreshes. Untracked paths leave the tree. A path already in the index stays listed until it is removed from the index.

### Fixed

- Right-click on a changed file or path folder opens a context menu (**Open Diff**, **Open File**, **Add to .gitignore**, **Revert**). Those rows previously had only hover icons, so the menu did not open.

## [0.1.0] - 2026-09-29

First public release.

### Added

- **Repository Tree** view in the Source Control sidebar: open git repos grouped by folder path (nested checkouts, submodules, and worktrees share a common prefix when possible).
- Toolbar: **tree** vs **flat** layout, **sort by name** vs **sort by recent WIP** (last dirty activity in this window), **hide unchanged** repos (tree mode keeps ancestor folders that contain dirty repos), and **refresh**.
- Dirty repos expand to a **path-nested change list** (no separate Staged / Changes / Merge section headers; states still drive icons and decoration).
- **Revert** on changed files and path folders (unstage, then discard to HEAD; untracked under a reverted folder are removed). Use `"scm.alwaysShowActions": true` for inline revert buttons.
- Repo row actions: **sync**, **pull**, **push**; context menu **Reveal in Explorer** and **Open Repository in New Window**.
- Optional **Git Graph** / **GitLens** commit-graph actions on repo rows when those extensions are installed.
- Changed-file rows: click the row to open the **diff** (`git.openChange`); **go-to-file** opens the **working copy** in the editor.
- Unit tests for tree building, pruning, sorting, and SCM nesting.

### Fixed

- **Sort by name** uses a human, case-insensitive, numeric-aware order at every sibling level (portfolio folders/repos and change tree entries).

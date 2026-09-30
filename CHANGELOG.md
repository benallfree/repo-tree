# Changelog

All notable changes to **Repository Tree** are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.2.0] - 2026-09-29

First release-ready build for multi-repo workspaces.

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

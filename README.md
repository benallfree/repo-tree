# Repository Tree

**Repository Tree** is a new way to visualize complex agentic repository layouts: many independent git roots, nested submodules, and unrelated projects that still live in one workspace.

I keep a single monolithic workspace of all my projects and priorities in one IDE instance. In practice, agents are far better at making modifications when cross-project context is available in that window. Cursor’s default **Repositories** list and per-repo **Changes** views do not scale when you have a large portfolio of roots and nested checkouts.

This extension improves on that default by presenting a **tree** you can navigate for change review and change management: folder-grouped repos, path-nested dirty files under each repo, and the same diff, revert, and git actions without hopping between flat lists.

[Video walkthrough](https://youtu.be/XgD1qGyHyfU)

![Repository Tree in the Source Control sidebar](images/repository-tree.png)

## Install locally

```bash
./scripts/install.sh
```

Reload the window. Each install bumps **`package.json`** and the symlink folder to `{semver}-next-bN` (for example `0.3.0-next-b2`). That string is what **Extensions → Installation → Version** shows during dev, so you can tie UI behavior to a specific local build. Counters live in gitignored `.build-number` and `.build-base`. Before a release, restore committed semver in `package.json` (or `git checkout package.json`) and run `./scripts/release.sh` (see `.cursor/rules/release.mdc`).

Hide the built-in **Repositories** section from Source Control → `...` → Views if you only want the tree.

## Usage

### View toolbar

| Control | Action |
| --- | --- |
| Tree / flat | Toggle nested folders vs a single sorted list |
| Sort | Name, or recent WIP (last dirty activity in this window) |
| Filter | Hide clean repos; tree mode keeps parent folders |

Row action icons (stage, discard, commit, and similar) appear when you **hover or select** that row. The built-in **Changes** list uses a different control that keeps icons on every row; VS Code does not expose that for custom tree views. With a repo, section, folder, or changed file **selected**, the same actions also show in the **Repository Tree** panel toolbar above the list. Right-click any change row for the full context menu.

### Dirty repos

Expand a dirty repo to see **Staged Changes**, **Changes**, and **Merge Changes** (only sections that have files), each with path-nested files and folders. A path that is both staged and unstaged appears under both sections, same as the built-in Changes view.

Click a changed file row to open the diff. Use **Stage** / **Unstage** / **Discard** on files or **Stage All** / **Unstage All** / **Discard All** on a section or folder. Discard asks for confirmation. **Commit** on the repo row opens a message prompt. If anything is staged, only staged changes are committed. If nothing is staged, **Commit** stages and commits all modified files (same as stock **Commit All**). Repo rows also keep sync, pull, and push.

If [Git Graph](https://marketplace.visualstudio.com/items?itemName=mhutchie.git-graph) or GitLens is installed, the same graph action that **Changes** shows on each repository appears on the repo row.

## Develop

```bash
npm install
npm test
./scripts/install.sh
```

After **every** change to `src/` or `package.json`, run **`./scripts/install.sh`** again so Cursor loads the updated build (compile alone is not enough). Reload the window to smoke-test in the main app.

Optional: **Run Extension** (`.vscode/launch.json`) opens an Extension Development Host with `root.code-workspace`.

Release notes: [CHANGELOG.md](./CHANGELOG.md).

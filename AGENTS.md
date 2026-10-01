# AGENTS.md — Repository Tree

Cursor extension: nested **Repository Tree** in Source Control. Read [`README.md`](README.md) for usage.

## After every code change

Run **`./scripts/install.sh`** before marking work done. See [`.cursor/rules/local-install.mdc`](.cursor/rules/local-install.mdc).

```bash
npm test          # when you changed src/
./scripts/install.sh
```

Reload Cursor to pick up the new build in the host UI.

## Release

Follow [`.cursor/rules/release.mdc`](.cursor/rules/release.mdc). Run **`./scripts/release.sh`** (annotated tag, push tag, VSIX, GitHub release).

## Layout

| Path | Role |
|------|------|
| `src/extension.ts` | Tree provider, commands, expansion session |
| `src/scmTree.ts` | Sections, nesting, path helpers |
| `src/gitRepo.ts` | Git API wrappers (stage, commit, diff) |
| `scripts/install.sh` | Local symlink install + build bump |

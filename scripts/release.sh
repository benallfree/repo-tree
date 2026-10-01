#!/usr/bin/env bash
# Cut a GitHub release: test, VSIX, annotated tag, push, gh release.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

VERSION="$(node -e "
  const v = require('./package.json').version
  if (!/^\\d+\\.\\d+\\.\\d+$/.test(v)) {
    console.error('package.json must be release semver (reset dev -next-bN), got: ' + v)
    process.exit(1)
  }
  console.log(v)
")"

TAG="v${VERSION}"
VSIX="repo-tree-${VERSION}.vsix"
NOTES="$(mktemp)"

cleanup() {
  rm -f "$NOTES"
}
trap cleanup EXIT

if ! grep -q "## \\[${VERSION}\\]" CHANGELOG.md; then
  echo "CHANGELOG.md missing ## [${VERSION}] section" >&2
  exit 1
fi

npm test
npx --yes @vscode/vsce package --no-dependencies -o "$VSIX"

node "$(dirname "$0")/changelog-notes.mjs" "$VERSION" >"$NOTES"

if git rev-parse "$TAG" >/dev/null 2>&1; then
  echo "Tag ${TAG} already exists locally" >&2
  exit 1
fi

git tag -a "$TAG" -m "Release ${VERSION}"
git push origin main
git push origin "$TAG"

if gh release view "$TAG" --repo benallfree/repo-tree >/dev/null 2>&1; then
  echo "GitHub release ${TAG} already exists; uploaded VSIX only if you attach manually"
else
  gh release create "$TAG" \
    --repo benallfree/repo-tree \
    --title "$VERSION" \
    --notes-file "$NOTES" \
    "$VSIX"
fi

echo "Published ${TAG}: https://github.com/benallfree/repo-tree/releases/tag/${TAG}"

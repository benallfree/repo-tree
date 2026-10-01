#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

npm install
VERSION="$(node scripts/bump-build-version.mjs)"
npm run compile
EXT_DIR="${HOME}/.cursor/extensions"
TARGET="${EXT_DIR}/benallfree.repo-tree-${VERSION}"

mkdir -p "$EXT_DIR"
for old in "${EXT_DIR}"/benallfree.repo-tree-*; do
  if [[ -e "$old" && "$old" != "$TARGET" ]]; then
    rm -f "$old"
  fi
done

ln -sfn "$ROOT" "$TARGET"
echo "Linked ${TARGET} -> ${ROOT}"
echo "Reload the Cursor window to activate Repository Tree."

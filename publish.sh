#!/usr/bin/env bash
# Publish R Plot Pro to VS Code Marketplace, Open VSX and GitHub Releases.
#
# Secrets are NOT stored here. They live outside the repo in:
#   ~/.config/rplotpro/publish.env   (chmod 600)
# which must export VSCE_PAT (Azure DevOps PAT, scope Marketplace>Manage) and
# OVSX_PAT (open-vsx.org access token). GitHub Release uses the gh CLI auth.
#
# Usage:
#   ./publish.sh              # package + publish current package.json version everywhere
#   ./publish.sh --no-github  # skip the GitHub release step
set -euo pipefail
cd "$(dirname "$0")"

ENV_FILE="${RPLOTPRO_ENV:-$HOME/.config/rplotpro/publish.env}"
[ -f "$ENV_FILE" ] || { echo "!! secrets file not found: $ENV_FILE"; exit 1; }
# shellcheck disable=SC1090
. "$ENV_FILE"
: "${VSCE_PAT:?VSCE_PAT not set in $ENV_FILE}"
: "${OVSX_PAT:?OVSX_PAT not set in $ENV_FILE}"

VERSION="$(node -p "require('./package.json').version")"
VSIX="r-plot-pro-${VERSION}.vsix"
DO_GITHUB=1
[ "${1:-}" = "--no-github" ] && DO_GITHUB=0

echo "==> R Plot Pro v${VERSION}"

# 1. Package (compiles TS via vscode:prepublish) if the vsix is missing.
if [ ! -f "$VSIX" ]; then
  echo "==> packaging $VSIX"
  vsce package
fi

# 2. VS Code Marketplace, with a retry: the gallery API sometimes times out.
echo "==> publishing to VS Code Marketplace"
for attempt in 1 2 3; do
  if vsce publish --packagePath "$VSIX"; then break; fi
  echo "   marketplace attempt $attempt failed; retrying in 5s..."; sleep 5
  [ "$attempt" = 3 ] && { echo "!! marketplace publish failed"; exit 1; }
done

# 3. Open VSX (namespace is created once; ignore 'already exists').
echo "==> publishing to Open VSX"
npx --yes ovsx create-namespace ofurkancoban -p "$OVSX_PAT" 2>/dev/null || true
npx --yes ovsx publish "$VSIX" -p "$OVSX_PAT"

# 4. GitHub Release (tag vX.Y.Z), notes pulled from the top section of release_notes.md.
if [ "$DO_GITHUB" = 1 ]; then
  TAG="v${VERSION}"
  if gh release view "$TAG" >/dev/null 2>&1; then
    echo "==> GitHub release $TAG already exists; uploading vsix"
    gh release upload "$TAG" "$VSIX" --clobber
  else
    echo "==> creating GitHub release $TAG"
    NOTES="$(awk '/^## /{c++} c==1' release_notes.md)"
    gh release create "$TAG" --title "$TAG" --notes "$NOTES" "${VSIX}#R Plot Pro ${VERSION} (VSIX)"
  fi
fi

echo "==> done: v${VERSION} published"
echo "   Marketplace: https://marketplace.visualstudio.com/items?itemName=ofurkancoban.r-plot-pro"
echo "   Open VSX:    https://open-vsx.org/extension/ofurkancoban/r-plot-pro"

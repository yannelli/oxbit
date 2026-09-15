#!/usr/bin/env bash
# Cloud Agent environment bootstrap for Oxbit.
# Idempotent: safe to run repeatedly and against cached state.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# Node version comes from .node-version and must satisfy package.json engines
# (">=24 <25"). The base image ships an older Node, so pin the exact version
# through nvm and make it win over any system Node on PATH.
NODE_VERSION="$(tr -d '[:space:]' < .node-version)"
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"

if [ ! -s "$NVM_DIR/nvm.sh" ]; then
  echo "nvm not found at $NVM_DIR; cannot provision Node $NODE_VERSION" >&2
  exit 1
fi

# shellcheck disable=SC1091
. "$NVM_DIR/nvm.sh"

nvm install "$NODE_VERSION"
nvm alias default "$NODE_VERSION"
nvm use "$NODE_VERSION"

NODE_BIN="$NVM_DIR/versions/node/v$NODE_VERSION/bin"
export PATH="$NODE_BIN:$PATH"

# Persist Node $NODE_VERSION for future interactive shells and terminals so the
# repo's Node (not the base-image Node) is used everywhere.
if ! grep -q "versions/node/v$NODE_VERSION/bin" "$HOME/.bashrc" 2>/dev/null; then
  {
    echo ''
    echo '# Oxbit: use repo-pinned Node from nvm'
    echo "export NVM_DIR=\"$NVM_DIR\""
    echo "export PATH=\"$NODE_BIN:\$PATH\""
  } >> "$HOME/.bashrc"
fi

# pnpm is pinned via package.json "packageManager"; provision it through corepack.
corepack enable
corepack prepare "pnpm@9.15.0" --activate

echo "Using Node $(node --version) / pnpm $(pnpm --version)"

# Install workspace dependencies (runs the postinstall PTY repair).
pnpm install --frozen-lockfile

# Browser used by the Playwright journey suite (pnpm test:browser / pnpm check).
pnpm exec playwright install chromium

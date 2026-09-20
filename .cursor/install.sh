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
export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
export PATH="$BUN_INSTALL/bin:$NODE_BIN:$PATH"

if ! grep -q "versions/node/v$NODE_VERSION/bin" "$HOME/.bashrc" 2>/dev/null; then
  {
    echo ''
    echo '# Oxbit: use repo-pinned Node from nvm'
    echo "export NVM_DIR=\"$NVM_DIR\""
    echo "export PATH=\"$NODE_BIN:\$PATH\""
  } >> "$HOME/.bashrc"
fi

if ! command -v bun >/dev/null 2>&1 || [[ "$(bun --version)" != "1.4.2" ]]; then
  curl -fsSL https://bun.sh/install | bash -s -- bun-v1.4.2
fi
export PATH="$BUN_INSTALL/bin:$PATH"

if ! grep -q '/.bun/bin' "$HOME/.bashrc" 2>/dev/null; then
  {
    echo ''
    echo "export BUN_INSTALL=\"$BUN_INSTALL\""
    echo "export PATH=\"$BUN_INSTALL/bin:\$PATH\""
  } >> "$HOME/.bashrc"
fi

echo "Using Node $(node --version) / bun $(bun --version)"

bun install --frozen-lockfile

bunx playwright install chromium

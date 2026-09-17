#!/usr/bin/env bash
set -euo pipefail

fail() {
  printf 'oxbit: %s\n' "$*" >&2
  exit 1
}

main() {
  local install_dir="${OXBIT_INSTALL_DIR:-$HOME/.oxbit/source}"
  local command_name

  case "$(uname -s)" in
    Darwin|Linux) ;;
    *) fail "This installer supports macOS and Linux. On Windows, use WSL." ;;
  esac

  for command_name in git node npm pnpm rg; do
    command -v "$command_name" >/dev/null 2>&1 ||
      fail "Missing $command_name. Install Node 24, pnpm 9.15.0, Git, and ripgrep, then rerun this script."
  done

  [[ "$(node -p 'process.versions.node.split(".")[0]')" == 24 ]] ||
    fail "Node 24 is required. Switch Node versions, then rerun this script."
  [[ "$(pnpm --version)" == 9.15.0 ]] ||
    fail "pnpm 9.15.0 is required. Run npm install -g pnpm@9.15.0, then rerun this script."

  case "$install_dir" in
    /*) ;;
    *) fail "OXBIT_INSTALL_DIR must be an absolute path." ;;
  esac
  if [[ -e "$install_dir" || -L "$install_dir" ]]; then
    fail "$install_dir already exists. Choose another OXBIT_INSTALL_DIR or update the existing checkout manually."
  fi

  printf 'Installing Oxbit in %s\n' "$install_dir"
  printf 'Building the terminal addon from source requires Python, make, and a C++ compiler.\n'
  mkdir -p "$(dirname "$install_dir")"
  GIT_TERMINAL_PROMPT=0 git clone --depth 1 https://github.com/yannelli/oxbit.git "$install_dir" </dev/null
  cd "$install_dir"
  CI=1 pnpm install --frozen-lockfile </dev/null
  pnpm install:global </dev/null

  printf '\nOxbit installed. Run oxbit in a project directory to start.\n'
  printf 'Keep %s: the global command links to this checkout.\n' "$install_dir"
  printf 'To update, run git pull --ff-only, pnpm install --frozen-lockfile, and pnpm install:global in that directory.\n'
  local global_bin
  global_bin="$(npm prefix -g)/bin"
  case ":$PATH:" in
    *":$global_bin:"*) ;;
    *) printf 'Add %s to your shell PATH to use the oxbit command.\n' "$global_bin" ;;
  esac
}

main "$@"

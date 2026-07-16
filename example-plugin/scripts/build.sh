#!/usr/bin/env bash
# Decky Plugin Studio — build + deploy to Steam Deck (remote, local, or release zip).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

# shellcheck source=lib/plugin-env.sh
. "$SCRIPT_DIR/lib/plugin-env.sh"
# shellcheck source=lib/deploy-manifest.sh
. "$SCRIPT_DIR/lib/deploy-manifest.sh"

red() { printf '\033[1;31m%s\033[0m\n' "$*"; }
green() { printf '\033[1;32m%s\033[0m\n' "$*"; }
cyan() { printf '\033[1;36m%s\033[0m\n' "$*"; }
bold() { printf '\033[1m%s\033[0m\n' "$*"; }

usage() {
  cat <<'EOF'
Usage: ./scripts/build.sh [command] [options]

Commands:
  dev       Build + deploy to remote Steam Deck (default)
  local     Build + deploy locally on this SteamOS/Bazzite machine
  release   Build distributable zip via Decky CLI
  deploy    Re-deploy last build without rebuilding

Options:
  --local         For 'deploy' command: deploy locally instead of remote
  --skip-install  Skip pnpm install when node_modules looks fresh
  -h, --help      Show this help
EOF
  exit 0
}

COMMAND="${1:-dev}"
shift || true
DEPLOY_LOCAL=false
SKIP_INSTALL=false

for arg in "$@"; do
  case "$arg" in
    --local) DEPLOY_LOCAL=true ;;
    --skip-install) SKIP_INSTALL=true ;;
    -h|--help) usage ;;
    *) red "Unknown option: $arg"; usage ;;
  esac
done

if [[ "$COMMAND" != "release" && "$COMMAND" != "-h" && "$COMMAND" != "--help" ]]; then
  if [[ ! -f .env ]]; then
    red ".env not found. Run ./scripts/setup-dev.sh first."
    exit 1
  fi
  decky_require_env "$REPO_ROOT"
  SSH_DEST="${DECK_USER}@${DECK_IP}"
  SSH_OPTS=(-p "$DECK_PORT")
  PLUGIN_DIR="${DECK_DIR}/homebrew/plugins/${PLUGIN_NAME}"
fi

deck_ssh() { ssh "${SSH_OPTS[@]}" "$SSH_DEST" "$@"; }
deck_scp() { scp -P "$DECK_PORT" "$@"; }

do_install() {
  if [[ "$SKIP_INSTALL" == "true" ]]; then
    echo "  Skipping pnpm install (--skip-install)"
    return
  fi
  if [[ -d node_modules && node_modules -nt package.json ]]; then
    if [[ ! -f pnpm-lock.yaml || node_modules -nt pnpm-lock.yaml ]]; then
      echo "  node_modules is up to date, skipping install"
      return
    fi
  fi
  bold "Installing dependencies..."
  pnpm install
}

do_build() {
  bold "Building plugin frontend..."
  pnpm run build
  if [[ ! -f dist/index.js ]]; then
    red "dist/index.js not found after build."
    exit 1
  fi
}

ensure_pnpm() {
  if command -v pnpm &>/dev/null; then return; fi
  if command -v corepack &>/dev/null; then
    corepack enable >/dev/null 2>&1 || true
    corepack prepare pnpm@latest --activate >/dev/null 2>&1 || true
  fi
  if ! command -v pnpm &>/dev/null; then
    red "pnpm is not available. Run ./scripts/setup-dev.sh first."
    exit 1
  fi
}

ensure_node() {
  if command -v node &>/dev/null; then return; fi
  if command -v pnpm &>/dev/null; then
    pnpm env use --global lts >/dev/null 2>&1 || true
  fi
  if ! command -v node &>/dev/null; then
    red "node is not available in this shell."
    exit 1
  fi
}

do_full_build() {
  ensure_pnpm
  ensure_node
  do_install
  do_build
}

copy_sources_to_dir() {
  local dest="$1"
  local rel
  while IFS= read -r rel; do
    [[ -z "$rel" ]] && continue
    if [[ -d "$REPO_ROOT/$rel" ]]; then
      mkdir -p "$dest/$rel"
      cp -a "$REPO_ROOT/$rel/." "$dest/$rel/"
    else
      mkdir -p "$(dirname "$dest/$rel")"
      cp -a "$REPO_ROOT/$rel" "$dest/$rel"
    fi
  done < <(decky_list_deploy_sources "$REPO_ROOT")
}

deploy_remote() {
  cyan "Deploying to Steam Deck at ${SSH_DEST}..."
  mapfile -t SOURCES < <(decky_list_deploy_sources "$REPO_ROOT")
  if [[ ${#SOURCES[@]} -eq 0 ]]; then
    red "Nothing to deploy — run a build first."
    exit 1
  fi

  bold "Stopping plugin_loader & preparing plugin directory..."
  deck_ssh "sudo systemctl stop plugin_loader 2>/dev/null || true; \
    sudo rm -rf ${PLUGIN_DIR}; \
    sudo mkdir -p ${PLUGIN_DIR}; \
    sudo chown -R ${DECK_USER} ${PLUGIN_DIR}"

  bold "Copying files..."
  for rel in "${SOURCES[@]}"; do
    if [[ -d "$REPO_ROOT/$rel" ]]; then
      deck_scp -r "$REPO_ROOT/$rel" "${SSH_DEST}:${PLUGIN_DIR}/"
    else
      deck_scp "$REPO_ROOT/$rel" "${SSH_DEST}:${PLUGIN_DIR}/"
    fi
  done

  bold "Restarting plugin_loader..."
  deck_ssh "sudo chmod -R 755 ${PLUGIN_DIR}; sudo systemctl start plugin_loader"
  green "Remote deploy complete!"
}

deploy_local() {
  LOCAL_PLUGIN_DIR="$HOME/homebrew/plugins/${PLUGIN_NAME}"
  cyan "Deploying locally to ${LOCAL_PLUGIN_DIR}..."

  bold "Stopping plugin_loader & preparing plugin directory..."
  sudo systemctl stop plugin_loader 2>/dev/null || true
  sudo rm -rf "$LOCAL_PLUGIN_DIR"
  sudo mkdir -p "$LOCAL_PLUGIN_DIR"
  sudo chown -R "$(whoami)" "$LOCAL_PLUGIN_DIR"

  bold "Copying files..."
  copy_sources_to_dir "$LOCAL_PLUGIN_DIR"

  bold "Restarting plugin_loader..."
  sudo chmod -R 755 "$LOCAL_PLUGIN_DIR"
  sudo systemctl start plugin_loader
  green "Local deploy complete!"
}

do_release() {
  CLI_BIN="$REPO_ROOT/cli/decky"
  if [[ ! -x "$CLI_BIN" ]]; then
    red "Decky CLI not found at $CLI_BIN — run ./scripts/setup-dev.sh"
    exit 1
  fi
  bold "Building plugin zip with Decky CLI..."
  sudo "$CLI_BIN" plugin build "$REPO_ROOT"
  if ls out/*.zip 1>/dev/null 2>&1; then
    green "Release build complete!"
    ls -lh out/*.zip
    for z in out/*.zip; do
      bash "$SCRIPT_DIR/verify-decky-plugin-zip.sh" "$z" || exit 1
    done
  else
    red "Expected zip in out/ but none found."
    exit 1
  fi
}

cyan "========================================"
cyan " Decky Plugin Studio — Build ($COMMAND)"
cyan "========================================"
echo

case "$COMMAND" in
  dev)
    do_full_build
    echo
    deploy_remote
    ;;
  local)
    decky_load_env "$REPO_ROOT"
    PLUGIN_NAME="$(decky_resolve_plugin_name "$REPO_ROOT")"
    do_full_build
    echo
    deploy_local
    ;;
  release)
    ensure_pnpm
    ensure_node
    do_install
    do_build
    echo
    do_release
    ;;
  deploy)
    if [[ ! -f dist/index.js ]]; then
      red "dist/index.js not found — run a build first."
      exit 1
    fi
    echo
    if [[ "$DEPLOY_LOCAL" == "true" ]]; then
      decky_load_env "$REPO_ROOT"
      PLUGIN_NAME="$(decky_resolve_plugin_name "$REPO_ROOT")"
      deploy_local
    else
      deploy_remote
    fi
    ;;
  -h|--help) usage ;;
  *)
    red "Unknown command: $COMMAND"
    usage
    ;;
esac

echo
green "Done!"

#!/usr/bin/env bash
# Shared .env + plugin name resolution for Decky Plugin Studio shell scripts.
# PLUGIN_NAME: .env override, else slug(plugin.json name) — matches MCP deck.deploy.

decky_slug_plugin_name() {
  local raw="$1"
  echo "$raw" | tr '[:upper:]' '[:lower:]' | sed -E 's/[[:space:]]+/-/g'
}

decky_load_env() {
  local repo_root="$1"
  if [[ -f "$repo_root/.env" ]]; then
    set -a
    # shellcheck disable=SC1091
    source "$repo_root/.env"
    set +a
  fi
  DECK_PORT="${DECK_PORT:-22}"
  DECK_USER="${DECK_USER:-deck}"
  DECK_DIR="${DECK_DIR:-/home/deck}"
}

decky_resolve_plugin_name() {
  local repo_root="$1"
  if [[ -n "${PLUGIN_NAME:-}" ]]; then
    echo "$PLUGIN_NAME"
    return
  fi
  local plugin_json="$repo_root/plugin.json"
  if [[ ! -f "$plugin_json" ]]; then
    echo "Error: plugin.json not found and PLUGIN_NAME not set in .env" >&2
    return 1
  fi
  local name
  name="$(python3 -c "import json,sys; print(json.load(open(sys.argv[1])).get('name',''))" "$plugin_json" 2>/dev/null || true)"
  if [[ -z "$name" ]]; then
    name="$(basename "$repo_root")"
  fi
  decky_slug_plugin_name "$name"
}

decky_require_env() {
  local repo_root="$1"
  decky_load_env "$repo_root"
  : "${DECK_IP:?DECK_IP is not set in .env}"
  PLUGIN_NAME="$(decky_resolve_plugin_name "$repo_root")"
  export DECK_IP DECK_PORT DECK_USER DECK_DIR PLUGIN_NAME
}

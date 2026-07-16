#!/usr/bin/env bash
# Enumerate deploy paths — keep in sync with mcp-server/src/deploy/copyManifest.ts

DECKY_DEPLOY_ENTRIES=(
  dist
  main.py
  plugin.json
  package.json
  assets
  py_modules
  defaults
  bin
  locales
)

decky_list_deploy_sources() {
  local repo_root="$1"
  local entry rel src
  for entry in "${DECKY_DEPLOY_ENTRIES[@]}"; do
    if [[ -e "$repo_root/$entry" ]]; then
      printf '%s\n' "$entry"
    fi
  done
  shopt -s nullglob
  for src in "$repo_root"/*.py; do
    rel="$(basename "$src")"
    case "$rel" in
      main.py|setup.py|conftest.py) continue ;;
    esac
    printf '%s\n' "$rel"
  done
  shopt -u nullglob
}

#!/usr/bin/env bash
# Verify a Decky distributable zip contains the minimum runtime layout for any plugin.
set -euo pipefail

usage() {
  echo "Usage: $0 path/to/plugin.zip" >&2
  exit 1
}

[[ $# -eq 1 ]] || usage
ZIP="$1"
if [[ ! -f "$ZIP" ]]; then
  echo "verify-decky-plugin-zip: not a file: $ZIP" >&2
  exit 1
fi

TMP="$(mktemp -d)"
cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT

unzip -q "$ZIP" -d "$TMP"

mapfile -t manifests < <(find "$TMP" -name plugin.json -type f 2>/dev/null || true)
if [[ ${#manifests[@]} -eq 0 ]]; then
  echo "verify-decky-plugin-zip: no plugin.json inside zip" >&2
  exit 1
fi

ROOT="$(dirname "${manifests[0]}")"
MISSING=()

need_file() {
  local rel="$1"
  if [[ ! -f "$ROOT/$rel" ]]; then
    MISSING+=("$rel")
  fi
}

need_file main.py
need_file plugin.json
need_file package.json
need_file dist/index.js

if [[ ${#MISSING[@]} -gt 0 ]]; then
  echo "verify-decky-plugin-zip: missing required paths under plugin root:" >&2
  printf '  %s\n' "${MISSING[@]}" >&2
  exit 1
fi

echo "verify-decky-plugin-zip: OK ($ROOT)"

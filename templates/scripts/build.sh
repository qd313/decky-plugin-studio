#!/usr/bin/env bash
# Thin build wrapper — deploy via Decky Plugin Studio MCP (deck.deploy).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

if command -v pnpm &>/dev/null; then
  pnpm run build
elif command -v npm &>/dev/null; then
  npm run build
else
  echo "Error: pnpm or npm required." >&2
  exit 1
fi

echo ""
echo "Build complete. Deploy to Deck with Decky Plugin Studio MCP:"
echo "  plugin.build  (validate + build)"
echo "  deck.deploy   (build + deploy to configured Deck)"

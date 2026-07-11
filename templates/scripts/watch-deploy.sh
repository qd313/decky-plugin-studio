#!/usr/bin/env bash
# Rollup watch + debounced reminder to deploy via MCP (deck.deploy).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

DEBOUNCE_MS=1500

cyan() { printf '\033[1;36m%s\033[0m\n' "$*"; }
green() { printf '\033[1;32m%s\033[0m\n' "$*"; }

cyan "Decky watch-deploy (debounce ${DEBOUNCE_MS}ms)"
cyan "  Rollup rebuilds dist/; run deck.deploy (MCP) after each debounced change."
echo

schedule_deploy_hint() {
  if [[ -n "${HINT_TIMER_PID:-}" ]] && kill -0 "$HINT_TIMER_PID" 2>/dev/null; then
    kill "$HINT_TIMER_PID" 2>/dev/null || true
  fi
  (
    sleep "$(awk "BEGIN { print ${DEBOUNCE_MS}/1000 }")"
    green "dist/ changed — deploy with Decky Plugin Studio MCP: deck.deploy"
    green "  Then Reload your plugin in QAM (Decky → your plugin)."
  ) &
  HINT_TIMER_PID=$!
}

if [[ ! -f dist/index.js ]]; then
  cyan "No dist/index.js — running one-shot build..."
  if command -v pnpm &>/dev/null; then
    pnpm run build
  else
    npm run build
  fi
  schedule_deploy_hint
fi

watch_loop() {
  if command -v inotifywait &>/dev/null; then
    inotifywait -m -e close_write,move,create -r dist 2>/dev/null | while read -r _; do
      schedule_deploy_hint
    done
  else
    cyan "inotifywait not found — polling dist/ every 2s"
    last_mtime=""
    while true; do
      if [[ -f dist/index.js ]]; then
        mtime="$(stat -c %Y dist/index.js 2>/dev/null || stat -f %m dist/index.js 2>/dev/null || echo "")"
        if [[ -n "$mtime" && "$mtime" != "$last_mtime" ]]; then
          last_mtime="$mtime"
          schedule_deploy_hint
        fi
      fi
      sleep 2
    done
  fi
}

trap '[[ -n "${HINT_TIMER_PID:-}" ]] && kill "$HINT_TIMER_PID" 2>/dev/null || true' EXIT

watch_loop &
WATCH_PID=$!

if command -v pnpm &>/dev/null; then
  pnpm run watch &
else
  npm run watch &
fi
WATCH_ROLLUP_PID=$!

trap 'kill "$WATCH_PID" "$WATCH_ROLLUP_PID" 2>/dev/null || true; [[ -n "${HINT_TIMER_PID:-}" ]] && kill "$HINT_TIMER_PID" 2>/dev/null || true' EXIT

wait "$WATCH_ROLLUP_PID"

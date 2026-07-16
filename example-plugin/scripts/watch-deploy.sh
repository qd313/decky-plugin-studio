#!/usr/bin/env bash
# Watch dist/ and debounced auto-deploy to Steam Deck.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

DEPLOY_LOCAL=false
DEBOUNCE_MS=1500

while [[ $# -gt 0 ]]; do
  case "$1" in
    --local) DEPLOY_LOCAL=true; shift ;;
    -h|--help)
      echo "Usage: ./scripts/watch-deploy.sh [--local]"
      exit 0
      ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done

cyan() { printf '\033[1;36m%s\033[0m\n' "$*"; }
green() { printf '\033[1;32m%s\033[0m\n' "$*"; }

if [[ ! -f .env ]]; then
  echo "Error: .env required (run ./scripts/setup-dev.sh first)." >&2
  exit 1
fi

invoke_deploy() {
  if [[ "$DEPLOY_LOCAL" == "true" ]]; then
    bash "$SCRIPT_DIR/build.sh" deploy --local
  else
    bash "$SCRIPT_DIR/build.sh" deploy
  fi
}

schedule_deploy() {
  if [[ -n "${DEPLOY_TIMER_PID:-}" ]] && kill -0 "$DEPLOY_TIMER_PID" 2>/dev/null; then
    kill "$DEPLOY_TIMER_PID" 2>/dev/null || true
  fi
  (
    sleep "$(awk "BEGIN { print ${DEBOUNCE_MS}/1000 }")"
    green "dist/ changed — deploying..."
    invoke_deploy || true
  ) &
  DEPLOY_TIMER_PID=$!
}

cyan "Decky watch-deploy (debounce ${DEBOUNCE_MS}ms)"
if [[ "$DEPLOY_LOCAL" == "true" ]]; then
  cyan "  deploy target: local"
else
  cyan "  deploy target: remote Deck (.env)"
fi
echo

if [[ ! -f dist/index.js ]]; then
  cyan "No dist/index.js — running one-shot build..."
  if command -v pnpm &>/dev/null; then pnpm run build; else npm run build; fi
  invoke_deploy
fi

watch_loop() {
  if command -v inotifywait &>/dev/null; then
    inotifywait -m -e close_write,move,create -r dist 2>/dev/null | while read -r _; do
      schedule_deploy
    done
  else
    cyan "inotifywait not found — polling dist/ every 2s"
    last_mtime=""
    while true; do
      if [[ -f dist/index.js ]]; then
        mtime="$(stat -c %Y dist/index.js 2>/dev/null || stat -f %m dist/index.js 2>/dev/null || echo "")"
        if [[ -n "$mtime" && "$mtime" != "$last_mtime" ]]; then
          last_mtime="$mtime"
          schedule_deploy
        fi
      fi
      sleep 2
    done
  fi
}

trap '[[ -n "${DEPLOY_TIMER_PID:-}" ]] && kill "$DEPLOY_TIMER_PID" 2>/dev/null || true' EXIT

watch_loop &
WATCH_PID=$!

if command -v pnpm &>/dev/null; then
  pnpm run watch &
else
  npm run watch &
fi
WATCH_ROLLUP_PID=$!

trap 'kill "$WATCH_PID" "$WATCH_ROLLUP_PID" 2>/dev/null || true; [[ -n "${DEPLOY_TIMER_PID:-}" ]] && kill "$DEPLOY_TIMER_PID" 2>/dev/null || true' EXIT

wait "$WATCH_ROLLUP_PID"

# Decky plugin — Bugbot review policy

## Maintainer intent

- **Review only** — inline comments on PRs; do not spawn Autofix runs that push `cursor/*` branches.
- Fixes land on the maintainer's active branch via local Cursor sessions, then **`plugin.build`** and **`deck.deploy`** (or `./scripts/build.sh` / `./scripts/build.ps1` for build-only) before merge.

## Do not

- Open PRs or push branches named `cursor/critical-bug-*`, `cursor/critical-correctness-*`, or any `cursor/*` prefix.
- Auto-commit autofix changes to ephemeral investigation branches.

## Do

- Flag critical correctness issues (RPC contracts, settings persistence, focus-graph regressions) with file/line references.
- Suggest running project test scripts (`pnpm test`, Python tests, etc.) when `src/` or `py_modules/` change.
- Defer Deck-only layout/focus QA to on-device runbook when preview cannot reproduce.

## Dashboard settings (required for enforcement)

Repo rules alone cannot block Cloud Agent pushes via the GitHub App. Maintainer should set:

1. [cursor.com/dashboard/bugbot](https://cursor.com/dashboard/bugbot) → **Autofix: Off** (team + personal override).
2. Optional: **Only when mentioned** (`cursor review` / `bugbot run`) to reduce noise.
3. Audit [cursor.com/automations](https://cursor.com/automations) for agents tied to this repo.

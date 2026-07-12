---
name: decky-release
description: >-
  Release checklist for Decky plugins: version bump, plugin.build, plugin.verifyZip,
  plugin.diffRpc, store packaging, and on-device smoke before publish.
  Use when preparing a store release or tagged version.
---

# Decky release

## When to use

- Bumping `plugin.json` version for store or GitHub release
- Preparing a zip for Decky Loader store submission
- Closing a milestone that ships to users

## Pre-release gates

```text
plugin.diffRpc     → no frontendOnly / backendOnly drift
plugin.build       → dist/ fresh
plugin.verifyZip   → plugin.json, dist/index.js, version, name
deck.deploy        → on-device smoke (not preview-only)
deck.readPluginLog → no tracebacks after smoke
```

## Version and manifest

1. Bump **`plugin.json`** `version` (semver).
2. Confirm **`name`**, **`author`**, icon/assets present.
3. Confirm **LICENSE** / **NOTICE** if distributing publicly.

## Store checklist (manual)

- [ ] Plugin zip layout matches Decky template (`dist/`, `main.py`, `plugin.json`, optional `py_modules/`, `assets/`).
- [ ] No secrets in zip (`.env`, API keys).
- [ ] README describes install and permissions.
- [ ] On-device Tier 0 smoke passed (`decky-tier-qa` or runbook).

## MCP tools

| Tool | Purpose |
|------|---------|
| `plugin.build` | Frontend/backend build |
| `plugin.verifyZip` | Required paths and manifest |
| `plugin.diffRpc` | TS `call()` ↔ `main.py` parity |
| `deck.deploy` | Deploy smoke build |
| `deck.reloadPlugin` | Reload without full redeploy when only Python hot-fixed |
| `deck.captureScreenshot` | Release evidence |

## Do not ship when

- Preview-only QA for focus, layout, or Steam Input scenarios.
- `plugin.diffRpc` reports unmatched methods.
- `deck.readPluginLog` shows errors after reload.

---
name: decky-dev-loop
description: >-
  End-to-end maintainer loop for any Decky plugin on Steam Deck: build/deploy via
  MCP, watch-deploy, BPM vs Gaming Mode testing, screenshots, optional log tunnel,
  and when to use decky-screenshot-ingest. Use when changing src/, main.py,
  plugin.json, or closing Deck-facing UI/RPC work.
---

# Decky plugin dev loop

## When to use

- After editing **Deck-facing** code: `src/`, `main.py`, `py_modules/`, `plugin.json`.
- Before marking UI/focus/RPC tasks done.
- When the user asks how to test on Deck or iterate quickly.

## One-time setup

From repo root:

```bash
cp .env.example .env   # DECK_IP, DECK_USER (and PC_IP if using ingest tunnel)
```

Configure Deck connection via MCP **`deck.configure`** (`DECK_IP`, `DECK_USER`, ingest port) or `.env` values the MCP server reads.

Same-machine Deck dev: `DECK_IP=127.0.0.1`.

## Build and deploy (MCP preferred)

| Goal | MCP tool |
|------|----------|
| Validate + build frontend/backend | **`plugin.build`** |
| Build + deploy to Deck | **`deck.deploy`** |
| Pull UI screenshot from Deck | **`deck.captureScreenshot`** |

Shell fallback (build only — deploy still via MCP):

```bash
./scripts/build.sh    # or .\scripts\build.ps1
```

After deploy, if QAM does not show changes: **Decky Reload** in QAM or restart `plugin_loader`.

**Flaky deploy:** retry `deck.deploy` once; if still failing after ~60–90s, stop and report (SSH/sudo/plugin_loader).

## Fast frontend loop (watch)

1. Terminal: `./scripts/watch-deploy.sh` (runs `pnpm run watch` / `npm run watch`).
2. Rollup rebuilds `dist/`; script debounces and reminds you to **`deck.deploy`** (deploy-only — no full install).
3. In Steam Desktop → **Big Picture Mode** → QAM → Decky → **Reload** your plugin after each deploy.

Python/RPC changes still need a full deploy (`deck.deploy` copies `py_modules/` + `main.py`).

## Which test track?

| Track | When |
|-------|------|
| **A — BPM (Desktop)** | Daily UI, settings, RPC, D-pad focus in QAM |
| **B — Gaming Mode** | Steam Input, in-game overlay, gamescope behavior |

Track A: Steam Desktop → View → Big Picture → QAM → your plugin.  
Track B: Return to Gaming Mode → QAM → your plugin.

Use your project's device QA runbook / smoke checklist when present (`docs/device-qa-runbook.md`, `docs/prompt-testing.md`).

## Automated gates (before handoff)

From repo root (adjust to your `package.json` scripts):

```bash
pnpm exec tsc --noEmit   # if TypeScript
pnpm test                # if configured
pnpm run build           # or npm run build
```

Deck-facing changes: also run **`plugin.build`** then **`deck.deploy`** before closing the task.

## Visual verification (screenshots)

When debugging layout, focus, or QAM:

1. Reproduce on Deck (QAM open for game-mode UI).
2. **`deck.captureScreenshot`** (MCP) — preferred in Cursor / Decky Plugin Studio.
3. Or run `scripts/screenshot-deck.ps1` / `scripts/screenshot-deck.sh` if present in the workspace.
4. Follow **decky-screenshot-ingest** skill: read newest `screenshots/DeckCapture_*.png`.

## Optional debug log tunnel

If verbose/debug `fetch` targets `127.0.0.1:<port>` on the Deck:

1. **`deck.configure`** — set ingest port.
2. **`deck.startTunnel`** on the dev PC (leave session open).
3. **`deck.probeIngest`** / **`deck.tailIngest`** to confirm capture.

Do not commit private IPs or ingest secrets — use `.env` / MCP config only.

## Related skills & docs

- `.cursor/skills/decky-preview/SKILL.md` — in-IDE QAM preview
- `.cursor/skills/decky-screenshot-ingest/SKILL.md` — ingest `screenshots/`
- `.cursor/skills/decky-tier-qa/SKILL.md` — tiered preview + on-device QA
- `AGENTS.md` — MCP tool reference

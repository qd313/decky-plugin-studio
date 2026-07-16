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
cp .env.example .env   # DECK_IP, DECK_USER
./scripts/setup-dev.sh # once: SSH keys (+ Decky CLI on Linux)
```

Configure Deck connection via MCP **`deck.configure`** (`DECK_IP`, `DECK_USER`, ingest port) or `.env` values the MCP server reads.

Same-machine Deck dev: `DECK_IP=127.0.0.1`.

## Build and deploy (MCP preferred)

| Goal | MCP tool |
|------|----------|
| Validate + build frontend/backend | **`plugin.build`** |
| Build + deploy to Deck | **`deck.deploy`** |
| Pull UI screenshot from Deck | **`deck.captureScreenshot`** |
| Pull screen recording from Deck | **`deck.record`** (open QAM + plugin first) |

Shell fallback (build + deploy):

```bash
./scripts/build.sh          # remote Deck
./scripts/build.sh local    # same SteamOS machine
.\scripts\build.ps1         # Windows → remote Deck
```

After deploy, if QAM does not show changes: **Decky Reload** in QAM or restart `plugin_loader`.

**Flaky deploy:** retry `deck.deploy` once; if still failing after ~60–90s, stop and report (SSH/sudo/plugin_loader).

## Fast frontend loop (watch)

1. Terminal: `./scripts/watch-deploy.sh` or `.\scripts\watch-deploy.ps1` (rollup watch + debounced deploy).
2. Rollup rebuilds `dist/`; script debounces and runs **`scripts/build.*`** deploy.
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

## Visual verification (screenshots & recordings)

When debugging layout, focus, or QAM:

1. Reproduce on Deck — **QAM open**, plugin panel visible.
2. **`deck.captureScreenshot`** or **`deck.record`** (MCP) — composited capture; fails closed without QAM/plugin unless `allowNonPluginUi`.
3. Or run `scripts/screenshot-deck.*` / `scripts/record-deck.*` if present after Init Pack.
4. Screenshots: follow **decky-screenshot-ingest** skill (`screenshots/DeckCapture_*.png`).
5. Recordings: `recordings/DeckRecord_*.mkv` — verify plugin chrome is readable in the clip.

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

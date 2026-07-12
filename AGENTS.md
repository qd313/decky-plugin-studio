# Decky Plugin Development — Agent Guide

This repository is configured for **Decky Plugin Studio**. Use the bundled MCP tools and subagent personas in `.cursor/agents/` when working on this plugin.

## Platform contract (read first)

- **Focus-graph first:** D-pad navigation uses Decky `Focusable` callbacks (`onMoveLeft`, `onMoveRight`, `onOKButton`, etc.), not DOM `keydown`.
- **Build parity:** After changes to `src/`, `main.py`, or `plugin.json`, run `plugin.build` (MCP) or `./scripts/build.sh` / `./scripts/build.ps1` before on-device QA.
- **Preview vs on-device:** The live preview is **very much beta**. Use `preview.start` for fast UI iteration; use `deck.deploy` + on-device QA for focus/layout bugs the preview cannot reproduce faithfully.

## MCP tools (Decky Plugin Studio)

| Tool | Purpose |
|------|---------|
| `deck.configure` | Set DECK_IP, DECK_USER, ingest port |
| `deck.startTunnel` / `deck.stopTunnel` | Reverse SSH tunnel for NDJSON ingest |
| `deck.probeIngest` / `deck.tailIngest` | Debug log capture from Deck |
| `deck.captureScreenshot` | Composited Deck screenshot (open QAM + plugin) |
| `deck.record` | Composited screen recording to `recordings/` |
| `deck.installCaptureHelper` | Install capture helpers on Deck |
| `deck.deploy` | Build + deploy (local SteamOS/Bazzite or remote SSH) |
| `plugin.detect` / `plugin.build` / `plugin.verifyZip` | Workspace validation and build |
| `preview.start` / `preview.stop` / `preview.status` / `preview.health` | In-IDE QAM preview |
| `preview.injectFocusEvent` | Simulate D-pad input |
| `preview.setHardware` | Drive hardware simulator (temps, battery, fans) |
| `preview.runSequence` | Replay input sequence + return DOM snapshot |
| `preview.callRpc` / `preview.readLog` | Backend RPC and log tail |
| `preview.snapshotDom` / `preview.captureScreenshot` | Idle DOM inspect + preview PNG |
| `preview.setHttpAllow` | Extend HTTP passthrough allowlist |
| `preview.setPermissions` | Deny capabilities in preview |
| `preview.callTestHook` | Drive `window.__deckyPreviewTestHooks` |

## Preview test suite

```bash
node scripts/run-preview-suite.mjs --tier=smoke
```

Requires **Decky: Open Preview**. Agent loop: `.cursor/skills/decky-tier-qa/SKILL.md`.

## Subagents

- **decky-debugger** — Decky/Steam focus, layout, ingest/tunnel workflow

Related skills (not subagents): **decky-dev-loop**, **decky-tier-qa**, **decky-preview**, **decky-screenshot-ingest**.

Archive substantive runs in `.cursor/agents/SUBAGENT_REPORTS.md`.

## Preview limitations

See [PREVIEW_LIMITATIONS.md](../docs/PREVIEW_LIMITATIONS.md). Deck-only scenarios: `tests/preview-suite/deck-only.json` (template).

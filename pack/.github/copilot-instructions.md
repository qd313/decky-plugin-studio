# Decky Plugin Development — Copilot Guide

This repository is configured for **Decky Plugin Studio**. Use the bundled MCP tools (`.vscode/mcp.json`) when working on this plugin in VS Code with GitHub Copilot.

## Platform contract (read first)

- **Focus-graph first:** D-pad navigation uses Decky `Focusable` callbacks (`onMoveLeft`, `onMoveRight`, `onOKButton`, etc.), not DOM `keydown`.
- **Build parity:** After changes to `src/`, `main.py`, or `plugin.json`, run `plugin.build` (MCP) or `./scripts/build.ps1` / `./scripts/build.sh` before on-device QA.
- **Preview vs on-device:** Use `preview.start` for fast iteration; use `deck.deploy` + on-device QA for focus/layout bugs the preview cannot reproduce faithfully.

## MCP tools (Decky Plugin Studio)

| Tool | Purpose |
|------|---------|
| `deck.configure` | Set DECK_IP, DECK_USER, ingest port |
| `deck.startTunnel` / `deck.stopTunnel` | Reverse SSH tunnel for NDJSON ingest |
| `deck.probeIngest` / `deck.tailIngest` | Debug log capture from Deck |
| `deck.captureScreenshot` | Pull Deck UI screenshot |
| `deck.deploy` | Build + deploy (local SteamOS/Bazzite or remote SSH) |
| `plugin.detect` / `plugin.build` / `plugin.verifyZip` | Workspace validation and build |
| `preview.start` / `preview.stop` / `preview.status` | In-IDE QAM preview |
| `preview.injectFocusEvent` | Simulate D-pad input |
| `preview.setHardware` | Drive hardware simulator (temps, battery, fans) |
| `preview.runSequence` | Replay input sequence + return DOM snapshot |
| `preview.callRpc` / `preview.readLog` | Backend RPC and log tail |

## Cursor users

If you also use Cursor, run **Decky: Init Pack** to lay down `.cursor/` rules, skills, and subagent personas. See `AGENTS.md` when present.

## Preview limitations

- Approximate `@decky/ui` mocks (not pixel-perfect Steam CEF)
- Hardware reads served from simulator; writes logged/mocked
- Ollama allowed at `127.0.0.1:11434` by default; other HTTP blocked
- All Decky permissions treated as granted in preview

# Decky Plugin Development — Copilot Guide

This repository is configured for **Decky Plugin Studio**. Use the bundled MCP tools (`.vscode/mcp.json`) when working on this plugin in VS Code with GitHub Copilot.

## Platform contract (read first)

- **Focus-graph first:** D-pad navigation uses Decky `Focusable` callbacks (`onMoveLeft`, `onMoveRight`, `onOKButton`, etc.), not DOM `keydown`.
- **Build parity:** After changes to `src/`, `main.py`, or `plugin.json`, run `plugin.build` (MCP) or `./scripts/build.ps1` / `./scripts/build.sh` before on-device QA.
- **On-device QA:** use `deck.deploy` + the `deck.*` tools for focus/layout bugs; `plugin.lintFocus` is static only.

## MCP tools (Decky Plugin Studio)

| Tool | Purpose |
|------|---------|
| `deck.configure` | Set DECK_IP, DECK_USER, ingest port |
| `deck.startTunnel` / `deck.stopTunnel` | Reverse SSH tunnel for NDJSON ingest |
| `deck.probeIngest` / `deck.tailIngest` | Debug log capture from Deck |
| `deck.captureScreenshot` | Pull Deck UI screenshot |
| `deck.deploy` | Build + deploy (local SteamOS/Bazzite or remote SSH) |
| `plugin.detect` / `plugin.build` / `plugin.verifyZip` | Workspace validation and build |

## Cursor users

If you also use Cursor, run **Decky: Init Pack** to lay down `.cursor/` rules, skills, and subagent personas. See `AGENTS.md` when present.

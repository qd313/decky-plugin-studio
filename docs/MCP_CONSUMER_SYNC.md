# MCP consumer sync (follow-on)

Decky Plugin Studio is the **source of truth** for Decky MCP tools, capture scripts, and extension packaging. Product repos (e.g. bonsAI) should **consume**, not fork, the MCP server.

## Distribution

| Mode | When | `mcp.json` entry |
|------|------|------------------|
| **Normal** | Day-to-day plugin dev | Installed VSIX path under `~/.cursor/extensions/` or VS Code equivalent |
| **Dev** | Hacking studio itself | Local checkout: `node` → `<studio>/mcp-server/dist/index.js` |

## Version pin

Consumer repos should document a **minimum** Decky Plugin Studio / MCP version (e.g. in `AGENTS.md` or a validate script). Bump the pin when studio ships capture/record changes.

## What syncs vs what stays in the product repo

| Sync from studio | Stay in product repo |
|------------------|----------------------|
| MCP server (via extension) | Product-specific MCP (e.g. bonsai knowledge server) |
| `deck.*` / `plugin.*` / `studio.*` tools | Ollama setup, app wipe, product-only maintenance scripts |
| Init Pack skills + `templates/scripts/` | Domain agents and product docs |

**Shell scripts:** `templates/scripts/` in studio is canonical (setup-dev, build/deploy, capture, tunnel, watch-deploy). Init Pack copies them into consumer plugin repos. Product repos should **thin or remove** duplicate `scripts/` over time and pin a minimum studio version in `AGENTS.md`.

After studio ships composited capture, consumers should **thin or remove** duplicate `scripts/deck/*` and point maintainers at MCP + Init Pack templates.

The `preview.*` tools were retired on 2026-10-24. A consumer that still calls them must stop. `.decky/preview.json` is still read for `panelRootSelector` and `preDeployCommand`.

## What a consumer should know about the tools

- **`machine`.** Every `deck.*` call takes `machine: "<name>"`. Without it the call drives `deck`, the real Deck, exactly as before. Every result carries `machine: { name, kind, os }`; check `kind` before filing a verdict as the Deck's.
- **The lease.** Only one session drives a machine at a time. A driving call from a second session is refused, naming the holder. Release with `deck.releaseMachine` when a session is done.
- **`bridgeReady`.** `deck.status` reports `bridgePortOpen`. `bridgeReady` is the same value under its old name, kept as an alias because bonsAI reads it. New code should read `bridgePortOpen`.
- **`deadlineMs`.** Every call has a deadline (10 minutes for driving tools). Pass `deadlineMs` to change it.

## Release flow (studio)

1. Work lands on `main` (there is no `develop` branch)
2. Bump the version in `extension/package.json` (+ root `package.json`, `mcp-server/package.json` and `SERVER_INFO` in `mcp-server/src/index.ts`)
3. GitHub Actions publishes Release `vX.Y.Z` with `.vsix` attached

No file watcher between repos — publish studio, then bump consumer pin in a small follow-up PR.

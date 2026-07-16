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
| `deck.*` / `preview.*` / `plugin.*` tools | Ollama setup, app wipe, product-only maintenance scripts |
| Init Pack skills + `templates/scripts/` | Domain agents and product docs |

**Shell scripts:** `templates/scripts/` in studio is canonical (setup-dev, build/deploy, capture, tunnel, watch-deploy). Init Pack copies them into consumer plugin repos. Product repos should **thin or remove** duplicate `scripts/` over time and pin a minimum studio version in `AGENTS.md`.

After studio ships composited capture, consumers should **thin or remove** duplicate `scripts/deck/*` and point maintainers at MCP + Init Pack templates.

## Release flow (studio)

1. Develop on `develop`
2. Merge to `main` with version bump in `extension/package.json` (+ root `package.json`)
3. GitHub Actions publishes Release `vX.Y.Z` with `.vsix` attached

No file watcher between repos — publish studio, then bump consumer pin in a small follow-up PR.

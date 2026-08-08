# Changelog

## [Unreleased]

### Added

- **Real MCP protocol support.** `mcp-server` now serves a compliant `initialize`, `tools/list` and `tools/call`, exposing all 34 tools to any MCP client (Claude Code, Cursor, Copilot). Previously it spoke only a private JSON-RPC dialect, so external agents saw zero tools and the handshake failed. The extension's own dialect is detected per-connection and continues to work unchanged.
- `mcp-server/src/toolRegistry.ts` — tool names, descriptions and JSON Schemas, with `toolRegistry.test.ts` diffing the registry against the dispatch switch so a new tool cannot silently become undiscoverable.
- **Claude Code target for Init Pack** — `pack/.claude/` (3 agents, 8 skills, hooks in `settings.json`), `pack/CLAUDE.md`, `pack/.mcp.json`. Init Pack now asks whether to install Cursor, Claude Code, or both; editor-neutral files are copied either way.
- `templates/scripts/decky-claude-hook.mjs` — adapts the pack's hint scripts to Claude Code's hook model (tool-name matchers plus a stdin payload) so the same scripts serve both editors.
- SteamOS design tokens split into `preview-server/src/styles/tokens.css` and `controls.css`, shared by the preview iframe *and* the webview chrome.

### Changed

- **Preview is now a true-to-device QAM frame.** The iframe was `flex:1` and filled whatever width the panel happened to be; it is now a fixed 400px right-docked flyout on a 1280x800 Deck stage, scaled to fit. Clipping and overflow bugs that only appear at real QAM width are now visible in preview.
- The QAM / Desktop toolbar buttons now work. They were rendered and styled but never wired to a click handler.
- Webview chrome restyled from VS Code gray to the shared SteamOS tokens, so the chrome and the plugin content no longer read as two different design systems.
- `input[type=range]`, `select` and `input[type=checkbox]` are styled to SteamOS in both the shim components and the hardware simulator; they previously rendered as raw Chromium widgets.
- Styled the six shim classes that had no CSS rule at all: `.decky-router`, `.decky-sidebar`, `.decky-field`, `.decky-slider-field`, `.decky-dropdown`, `.decky-spinner`.
- `.decky-qam-scope` has real padding — content used to touch the flyout edges.
- Log console gains severity colouring and a 500-line cap; it previously appended to `textContent` without bound.

### Fixed

- Server no longer replies with an error to JSON-RPC notifications. Answering `notifications/initialized` violated the spec and broke the handshake for strict MCP clients.
- Preview start waits for Vite and the Python sidecar to actually respond instead of sleeping a fixed 1500ms, and reports which one failed.
- Preview port is bind-tested instead of a blind `5173 + random(1000)`, which could silently collide.
- Screenshot capture reads its background and text colours from the live tokens; it hardcoded `#1b2838`/`#c7d5e0` while the page rendered `#0e1419`, so captures never matched the screen. **Existing `tests/preview-baselines/` need regenerating.**
- Ollama status is addressed by id rather than a positional `.hw-panel div:last-child` selector that broke on any markup change and threw when the panel was empty.
- `ProgressBar` used the VS Code teal `#4ec9b0`; it now uses the Steam accent.
- Root `mcp.json` pointed at a hardcoded `...-extension-0.1.0/...` install path at v0.3.6; it now targets the local build.
- Removed dead `extension/src/preview/viewportFrame.html` and the unused `frameUri` computed from it.

## [0.3.6]

### Changed

- Init Pack focus guidance now bans `querySelector` / `activeElement` for Decky sibling/column hops; Pattern D documents mount-time focus-owner registries instead

## [0.3.5]

### Added

- **decky-ui-focus-gate** agent and **decky-ui-change-focus-gate** skill — mandatory D-pad focus triage before shipping Deck UI changes
- `ui-change-focus-gate` Cursor rule and `decky-focus-gate-hint` hook script in Init Pack templates
- Focus-graph patterns doc in Init Pack (`pack/docs/focus-graph-patterns.md`)
- Subagent report template for archiving focus gate triages

### Changed

- AGENTS.md documents the focus gate agent and skill alongside existing subagents

## [0.3.4]

### Added

- Universal plugin dev scripts in Init Pack templates: `setup-dev`, `revert-dev`, full `build`/`deploy`, `watch-deploy`, `reverse-tunnel-deck-ingest`, `verify-decky-plugin-zip`
- `templates/.env.example` copied on Init Pack
- `example-plugin/` pre-seeded with `scripts/` and `.env.example`
- `scripts/sync-plugin-templates.mjs` maintainer sync from templates → example-plugin

### Changed

- MCP bundle scripts now sync from `templates/scripts/` (single source of truth; removed `mcp-server/src/scripts/`)
- `revert-dev.ps1`: surgical SSH key removal (no longer wipes all `authorized_keys`)
- README and dev-loop skills document full Windows/Linux script paths

## [0.3.3]

### Added

- MCP **deck.reloadPlugin**, **deck.openPlugin** (manual QAM checklist), **deck.readPluginLog**, **deck.getEnv**
- MCP **plugin.diffRpc** — frontend `call()` vs `main.py` RPC parity
- MCP **preview.compareScreenshot** + `tests/preview-baselines/` visual regression
- MCP **preview.tailEmit** and **preview.callRpc** `collectEmitsMs` — experimental streaming RPC in preview sidecar
- Init Pack skills: **decky-onboard**, **decky-release**, **decky-focus-audit**; agent **decky-focus-architect**
- Hooks: build-parity reminder, RPC drift hint, handoff check; template scripts for deck-only lint
- Extension command **decky.showOpenPluginHint**; MCP tools in Decky tree

### Changed

- Pack agent set streamlined (decky-debugger + focus-architect); updated AGENTS.md and MCP docs

## [0.3.2]

### Fixed

- `/api/permissions` POST no longer re-parses the request body outside the try/catch; malformed JSON returns a safe `{}` response instead of leaving the HTTP response unsent

## [0.3.1]

### Fixed

- Preview shim event listeners: bind a single backend dispatch instead of stacking handlers per `addEventListener`
- Preserve sidecar-injected `hw_state` in Decky Shim instead of resetting it on module load
- Gamepad handler extraction in `focusManager` now reads Focusable callback props correctly

### Changed

- Remove temporary debug ingest logging from preview focus/modal paths
- Refresh extension-bundled pack and preview-server resources

## [0.3.0]

### Added

- Composited Deck screen recording via MCP `deck.record` (pipewire-gamescope / wf-recorder; plugin UI required)
- `deck.installCaptureHelper` — optional on-Deck helper install
- `deck.captureScreenshot` structured results and composited capture scripts (`studio-*`)
- CLI scripts in plugin workspaces: `scripts/record-deck.*`, `scripts/screenshot-deck.*`
- Auto GitHub Release on version bump to `main` (VSIX asset)
- Extension version shown in the status bar

### Changed

- Live preview documentation now marks preview as **very much beta**
- Retired red-team / blue-team agent personas from the pack

### Notes

- Open QAM + your plugin on the Deck before `deck.record` or composited screenshots
- Set `DECKY_STUDIO_ALLOW_STEAMOS_RW=0` to skip optional pacman on Deck

## [0.2.0]

- Dynamic preview RPC, preview test kit, deploy parity, permission simulator

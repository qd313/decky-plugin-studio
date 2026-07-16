# Changelog

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

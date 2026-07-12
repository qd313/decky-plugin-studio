# Changelog

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

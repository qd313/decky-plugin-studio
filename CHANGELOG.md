# Changelog

## [Unreleased]

> Package versions were bumped to **0.3.8** to deploy the killswitch into a running VS Code:
> installing the same version over itself fails with `EBUSY` because the editor holds the
> extension directory open, while a new version number installs alongside it. The entries
> below are still unreleased -- fold them into a `## [0.3.8]` section when cutting the
> release. `mcp-server` was on 0.3.6 while the extension was on 0.3.7 and the server
> reported that stale number over MCP `serverInfo`; all four are now pinned together.

### Added

- **Deck automation killswitch.** The rig presses real buttons on a real Deck, and until now nothing a human could hit stopped it on purpose -- the only backstop was the board's own neutral-on-silence watchdog, which covers the host dying and nothing else. A stop now: latches automation off, tells the board to release whatever it is holding, aborts any in-flight `deck_runSequence` / `deck_walkTo` / `deck_openPlugin`, and tears down the SSH tunnels (CDP forwards and the ingest reverse tunnel, reported separately). Reachable from a dedicated status bar item, the **Decky: Stop All Deck Automation** command, <kbd>ctrl+alt+.</kbd>, `pnpm stop`, and the `deck_stopAutomation` tool.
  - **The latch is a file** (`~/.config/decky-plugin-studio/automation-stop.json`), not a flag. There are always at least two server processes -- the extension's and the one an agent spawns from `mcp.json` -- and the process a human can reach is usually not the one driving the Deck. It also survives a server restart, which an in-memory latch does not.
  - **The latch is set first**, before the release, not last. Releasing first leaves a window in which an in-flight run presses again while the release is still opening the serial port.
  - **Re-arming is not a tool and cannot become one by accident.** It lives on the extension's private `control/` dialect, which the MCP surface has no route to; an MCP client asking for it gets `Unknown method`. An agent that can clear its own killswitch does not have one.
  - The status bar indicator reads the latch file directly rather than asking the server, so a dead server cannot render a stopped rig as armed, and it shows a warning background while a run has a live path to the Deck. `scripts/stop-deck-automation.mjs` writes the latch with nothing but `fs`, so the killswitch works in a checkout that was never built.
- `deck_stopAutomation` and `deck_automationStatus` MCP tools. `deck_status` now also reports `automationArmed`.
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

- **`deck_walkTo` could report `found` without the ring moving at all.** A walk for `"bonsAI"` returned success after **zero presses** because the focused element -- an icon-only QAM tab with no text of its own -- was named by the first ancestor that had any, which was the entire Quick Access Menu: `"NotificationsQuick SettingsPerformanceSoundtracksHelpDeckybonsAITabMaster…"`. "bonsAI" is a substring of that. Nothing stalled, errored or warned; the tool reported the ring somewhere it was not, and every assertion after it inherited that. A control's name is now computed on the page the way an accessibility tree computes one -- its own `aria-label`, then `aria-labelledby`, then **an `aria-label` on a descendant**, then its own text, and only then an ancestor's. That third rule is what finally makes a consumer's own fix work: Steam puts the ring on the outer `Focusable` wrapper, so an `aria-label` added to the tab's title node was invisible to a check that looked only at the focus target. The ancestor climb stays -- it is every Decky `ToggleField` -- but no longer wins, and it stops at 80 characters, because text longer than that belongs to a container rather than a control. Such a stop now comes back unnamed with `overshot: true` instead of matching a pane dump. Exposed as `label` / `labelSource` on every focus read, and shared by `deck_walkTo`, `deck_runSequence` and `deck_openPlugin`, which each used to rank the raw fields differently. `runSequence`'s copy was the worst of the three: it concatenated all three fields into one haystack, so with an inherited pane every needle in that pane counted as reached and `neverReached` -- the field an unattended run is trusted on -- could come back falsely empty.
- **The JavaScript `deck_readFocus` injects is now unit-tested.** It is a template literal, so nothing type-checked it and nothing ran it without a Deck; the bug above lived there for weeks behind a green suite, because the existing tests build focus payloads by hand and never execute the code that produces them. `readFocus.test.ts` evaluates the real expression against a small fake DOM.
- **`deck_openPlugin` reported `alreadyOpen: true` with the panel unmounted.** Three times in one session -- each after a `plugin_loader` restart, which closes the panel -- it returned `ok/verified/alreadyOpen` while the plugin's root was absent from the document, sending the caller off to act on a panel that was not there. Already-open was decided by finding the plugin's name among Decky's pane labels, and Decky's plugin **list** advertises every installed plugin's name, so the check could not tell "bonsAI's panel is open" from "bonsAI is a row in the list" -- the exact distinction it was added to make. New `rootSelector` input (defaulting to `panelRootSelector` in `.decky/preview.json`) takes a selector the plugin's own panel renders and settles it in both directions, overriding the labels; it also confirms the panel actually mounted after the A press, which the tool previously never checked. Without a selector the label heuristic now additionally requires Decky's own `"Decky"` pane title to be absent.
- **`deck_openPlugin` could not recover when the ring was on the QAM's left rail.** It walked 2 controls and gave up when one RIGHT press would have entered the pane -- and that is the normal state right after a game launches. All of the navigation sat under a single guard that conflated "the Decky pane is showing" with "the ring is in it", so the RIGHT press that enters the pane was unreachable in exactly the case it was needed, and the row search then walked DOWN the *rail*. Each navigation step now keys on its own precondition.
- **Remote deploy shipped the plugin unreadable, on every deploy from a Windows host.** Every uploaded directory landed `drwx------ root:root`, and Decky runs plugin backends unprivileged, so the backend died at import (`ModuleNotFoundError: No module named 'backend'`) on every start. `scp -r` sends the local directory's mode and the receiver applies its umask to files but not directories, so Win32 OpenSSH's ACL-derived `0700` arrived intact; `cp -a` preserved it and `chown -R root:root` made it fatal. The failure wears a disguise -- the loader serves the frontend as root, so the panel renders normally while its every RPC fails, and it reads as a settings bug. The staged upload is now `chmod -R u+rwX,go+rX`'d immediately before the elevated copy, so the copy carries correct modes; deliberately on the staging directory rather than the target, which holds content the deploy never shipped.
- **A second VS Code window no longer kills its own MCP server.** The debug-ingest listener binds a fixed `127.0.0.1:7682` and had no handler on the `http.Server` `'error'` event, so a port already held by another window's server arrived as an unhandled `'error'` and took the process down with exit code 1 -- before the MCP handshake, leaving the window looping `MCP server exited (code 1) before replying` with the real cause visible only as a raw Node stack in the output channel. `EADDRINUSE` is now caught, reported on stderr with the `deckyPluginStudio.ingestPort` / `DEBUG_INGEST_PORT` remedy, and disables **only** debug ingest; the server continues to serve every tool. `isIngestRunning()` reports the state, and a failed start leaves the singleton clear so a later start on a free port still works.
- Server no longer replies with an error to JSON-RPC notifications. Answering `notifications/initialized` violated the spec and broke the handshake for strict MCP clients.
- Preview start waits for Vite and the Python sidecar to actually respond instead of sleeping a fixed 1500ms, and reports which one failed.
- Preview port is bind-tested instead of a blind `5173 + random(1000)`, which could silently collide.
- Screenshot capture reads its background and text colours from the live tokens; it hardcoded `#1b2838`/`#c7d5e0` while the page rendered `#0e1419`, so captures never matched the screen. **Existing `tests/preview-baselines/` need regenerating.**
- Ollama status is addressed by id rather than a positional `.hw-panel div:last-child` selector that broke on any markup change and threw when the panel was empty.
- `ProgressBar` used the VS Code teal `#4ec9b0`; it now uses the Steam accent.
- Root `mcp.json` pointed at a hardcoded `...-extension-0.1.0/...` install path at v0.3.6; it now targets the local build.
- Removed dead `extension/src/preview/viewportFrame.html` and the unused `frameUri` computed from it.
- **The VSIX never bundled `bridge/tools/`.** `findPadTool()` walks up from the running server looking for `bridge/tools/pad.py`, and in an installed extension there was none to find -- so `deck_pressButton`, `deck_openPlugin` and the killswitch's release step could never work from a VSIX, only from a source checkout. Found while wiring the killswitch, since a status bar stop runs in the installed extension while the agent driving the Deck runs from source. Now bundled, with a packaging check that fails the build if `pad.py` is missing.

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

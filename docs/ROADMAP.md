# Decky Plugin Studio — roadmap (deferred)



Star ratings follow bonsAI [roadmap](https://github.com/cantcurecancer/bonsAI) legend (effort/risk, 1 = lowest).



| Item | Stars | Status | Notes |

|------|-------|--------|-------|

| Native Steam Input / HID bridge in preview | ★★★★★★ | Deferred | W3C Gamepad only; see PREVIEW_LIMITATIONS |

| Gamescope / QAM compositing in preview | ★★★★★★ | Deferred | Requires CEF/chrome capture |

| Deck UI automation (`deck.openPlugin` hard) | ★★★★ | Deferred | v1 returns agent checklist only |

| Auto `.env` → `config.ts` on deploy | ★★★ | Plugin-specific | Use `.decky/preview.json` `preDeployCommand` |

| Pixel-perfect `@decky/ui` mocks | ★★★★ | Partial | v0.2 richer shims; on-device QA still required |

| Spam-left escape chain (plugin → plugin list → QAM → game) | ★★★★★ | Deferred | **Verified on hardware 2026-08-14:** D-pad left at the plugin's leftmost stop moves focus to Steam's own QAM icon rail, and further left presses do nothing — Steam consumes them. So the chain is not a gap to fill, it is a Steam behavior to override. Getting past the rail means patching Steam's QAM UI, not plugin code: fragile across Steam updates, and it changes behavior system-wide rather than only inside the plugin. A narrower version (left at the plugin edge pops back to the Decky plugin list) may be ★★★ if the press can be intercepted before Steam takes it — unverified. |



## Features (planned)



| Item | Stars | Status | Notes |

|------|-------|--------|-------|

| **Studio issue intake** — report a DPS bug without leaving the IDE | ★★ | Planned | `studio.reportIssue` MCP tool + **Decky: Report Studio Issue** command + tree entry. Auto-captures a redacted diagnostic bundle (version, deck env, preview state, recent tool calls) and stamps a `reportId` into failed-tool errors so the agent that hits a bug can file it on the spot. Submits via `gh` or a prefilled issue URL; always previews before posting. Needs `.github/ISSUE_TEMPLATE/` + `surface:*` / `source:*` labels. Plan: [01-dpad-focus-oracle-and-issue-intake.md](planning/01-dpad-focus-oracle-and-issue-intake.md) § Part B |

| **Pluckable studio** — adopt one piece without adopting all of it | ★★★ | Planned | Today Init Pack is all-or-nothing. Split into independently installable modules a dev can take à la carte: (1) build/deploy/dev scripts, (2) hooks, (3) MCP tools, (4) subagents + skills, (5) preview + visual/capture, (6) D-pad focus linter. Each separately downloadable, each explained in the README in a few short steps, each stating plainly what it needs and what it does without the rest. **Dependency untangling is the real work, not packaging** — subagent instructions reference MCP tools, hooks assume the scripts exist, and (per the D1 "read it visually" decision) the focus linter needs the preview to render, so it is *not* independently pluckable as currently designed. Either the linter gains a source-only fallback mode or module 6 declares a hard dependency on module 5. |

| **Status bar is missing in VS Code** | ★ | Fixed 2026-08-26 | Reported 2026-08-26: the status bar shows in Cursor but not in VS Code. **Cause: the extension was not installed in VS Code at all.** `~/.vscode/extensions/` held 19 extensions and none was DPS; `~/.cursor/extensions/` had two (`0.1.2` and `0.3.6`). Cursor and VS Code keep separate extension directories, so a VSIX installed in one is invisible to the other. The status bar code was never at fault: [statusBar.ts](../extension/src/ui/statusBar.ts) calls `show()` unconditionally and `onStartupFinished` activation fires with or without a plugin workspace. **Resolved by building a fresh VSIX (`pnpm deploy:vscode`) and installing it** — `code --list-extensions` now reports `decky-plugin-studio.decky-plugin-studio-extension@0.3.6`, and the bundled MCP server carries the current deck tools (`deck_readPage`, `deck_walkTo`, `deck_runSequence`, `deck_waitFor`). **Two latent defects found while diagnosing were fixed at the same time**, because both produce this exact symptom and neither leaves a trace: (1) the item had no `id` or `name`, so a user who hid it had no findable entry in the status bar's right-click *Manage* menu — it looked gone forever; now `deckyPluginStudio.status` / "Decky Plugin Studio". (2) the text was one long item (`Decky v… | Preview ● | ● Tunnel | N ingest | ● Ollama | HW: …`) and VS Code **silently drops** right-aligned items that do not fit, with no overflow affordance — so a narrow window or a crowded bar made it vanish. Text is now `$(play) Decky ●●●` and every detail (plus `deckReachable`, which the bar never showed) moved to a markdown tooltip, which has no width limit. **Still open:** Cursor has 0.1.2 and 0.3.6 stacked — harmless (the highest version wins) but worth clearing so it is obvious which is live. |

| **Installed extension was inert — bundled MCP server could never start** | ★★ | Fixed 2026-08-26 | Found while chasing "the status bar says everything is offline". Three defects stacked into one misleading symptom. **(1) The VSIX never shipped the MCP server's dependencies.** [bundle-for-vsix.mjs](../extension/scripts/bundle-for-vsix.mjs) copied `mcp-server/dist` and nothing else — no `package.json`, no `node_modules` — while the preview-server got a full `npm install`. The server's first `import "pngjs"` threw `ERR_MODULE_NOT_FOUND` and the process died before reading a single request, so **every Studio tool was dead in any installed build, and always had been**. It only ever worked from a source checkout. Missing `package.json` also cost `"type": "module"`, leaving Node to guess ESM by sniffing syntax. Fixed by bundling the manifest and running `npm install --omit=dev`; VSIX grew 18.3 → 25.5 MB, nearly all of it `typescript`, which the lint rules genuinely need at runtime. **(2) The failure was silent.** `spawnMcpProcess()` was called with `.catch(() => {/* dev mode without built MCP */})`, and a dead server left `initialize` hanging for its full 120s timeout. Now the process `exit` and `error` events reject every in-flight request immediately, stderr is captured to a **Decky Plugin Studio** output channel, and `McpState.mcpHealth` distinguishes `starting` / `running` / `failed`. **(3) The status bar reported a dead server as a dead Deck.** Every signal it shows is read *from* the server, so when the server is down they are all false for the same uninformative reason — it rendered as "your Deck is offline" and sent the user to check their network. It now shows `$(warning) Decky (server failed)` on a warning background, and clicking it opens the log. **Guard added so this cannot ship again:** [smoke-mcp-bundle.mjs](../extension/scripts/smoke-mcp-bundle.mjs) starts the bundled server exactly as the installed extension does and fails the package step unless it answers `initialize`. A dependency check would have caught only this one omission; starting it catches the class. |

| **VS Code settings were read by nothing** | ★ | Fixed 2026-08-26 | `deckyPluginStudio.deckIp`, `.deckUser`, `.ingestPort`, `.previewHttpAllow` and `.localLoaderUnit` have been in the manifest since 0.1.0, and there was **not one `getConfiguration` call anywhere in the extension**. A user could type their Deck's IP into VS Code settings, see it saved, and get no connection and no complaint — the server only ever read `~/.config/decky-plugin-studio/deck.env`. A setting that does nothing is worse than no setting: it sends you looking at your network. `deckIp` / `deckUser` / `ingestPort` now reach the server as environment variables at spawn, and [config.ts](../mcp-server/src/config.ts) `readDeckEnv()` layers them over the file. **Blank counts as unset**, so the empty default cannot wipe out a working `deck.env`. Verified three ways: file only → reachable, override with a bogus IP → unreachable, blank override → still reachable. `previewHttpAllow` and `localLoaderUnit` are still unread — narrower, and neither has been reported. |

| **Status bar was a one-shot snapshot** | ★ | Fixed 2026-08-26 | `statusBar.refresh()` ran once at activation and there was no timer anywhere in the extension. Start a tunnel and the bar still said off; wake the Deck and it still said unreachable. The only cure was the refresh command, which you would only think to run if you already suspected the bar was lying. Now polls `deck_status` every 30s — a ping with a 1s deadline plus one local HTTP probe, cheap enough to repeat, slow enough not to spawn subprocesses in a tight loop. |

| **`deck_getEnv` hangs on an unreachable `DECK_IP`** | ★ | Open — found 2026-08-26 | [deckAutonomy.ts](../mcp-server/src/tools/deckAutonomy.ts) `getEnv()` calls `probeRemoteDeck()` whenever a non-local host is configured, and that SSH probe has no timeout. With a wrong IP the tool never returns — measured at >40s before the test gave up, against `pingDeck()`'s 1s deadline in the same call. Low impact today because the status bar polls `deck_status`, not `getEnv`. It matters the moment someone mistypes an IP and asks an agent what the environment looks like. Fix is a deadline on the probe, and reporting the timeout as a finding rather than hanging. |

| **Deck automation killswitch** — stop everything, instantly, from anywhere | ★★ | Planned — needed before wider use | The rig presses real buttons on a real device. There is a firmware backstop already (the bridge's neutral-on-silence watchdog releases every button if the host stops talking), but **there is nothing a human can hit to stop automation on purpose**, and that gap is now load-bearing: on 2026-08-26 a wrong chord left the ring on a game's **Play** button, one press from launching it, and the only recourse was noticing and stopping by hand. **Must do four things, in this order:** (1) release every held button on the board (`pad.py release`); (2) abort any in-flight `deck_runSequence` / `deck_walkTo` so the next queued press never goes out; (3) tear down SSH tunnels; (4) latch OFF so nothing can press again until the user re-arms — a stop that lets the next tool call resume is not a stop. **Easy to use is a requirement, not a nicety:** a status bar button that is always visible while automation is armed, a `Decky: Stop All Deck Automation` command, and a keybinding — reachable without knowing a tool name, and reachable while an agent is mid-run. It should be usable when the person hitting it does not know what is running. **Half the mechanism exists:** `DPS_NO_BRIDGE=1` already makes every press refuse before anything spawns ([pressButton.ts](../mcp-server/src/deck/pressButton.ts) `bridgeDisabled`), added after the test suite was caught sending live presses to a Deck. The killswitch is that latch plus a way to flip it that is not an environment variable, plus the release and abort steps. **Also needs an armed indicator** — the same status bar item should make it obvious when the rig can press, because a killswitch nobody knows to reach for is not a safety feature. |

| **Automated issue triage agent** — GitHub agent that triages and attempts fixes | ★★★ | Planned | Two tiers. Tier 1 (automatic, read-only): classify surface, dedupe, resolve the report against `main`, comment with `file:line` confirmation, label `agent-triaged`. Tier 2 (maintainer-gated on `agent-fix`): branch, fix, test, open a **draft** PR — never pushes `main`, never releases. Issue text is untrusted public input; `needs-hardware` reports must stop rather than guess. Depends on issue intake for signal quality. Plan: [01-dpad-focus-oracle-and-issue-intake.md](planning/01-dpad-focus-oracle-and-issue-intake.md) § Part C |



## Shipped in v0.3.x (autonomy pack)



- **deck.reloadPlugin**, **deck.openPlugin** (checklist), **deck.readPluginLog**, **deck.getEnv**

- **plugin.diffRpc** — frontend/backend RPC parity

- **preview.compareScreenshot** + `tests/preview-baselines/`

- **Streaming RPC (experimental)** — sidecar `decky.emit` → WS + **preview.tailEmit** / `collectEmitsMs`

- Pack skills: **decky-onboard**, **decky-release**, **decky-focus-audit**; agent **decky-focus-architect**

- Hooks: build parity, RPC drift hint, handoff check



## Shipped in v0.2.0



- Dynamic preview RPC discovery (`.decky/preview.json`)

- Unified deploy copy manifest + SSH retry

- Generic preview test kit + `preview.callTestHook` / `preview.health`

- Permission simulator, richer UI shims, hardened screenshot MCP

- Vitest harness template, dev-loop / tier-qa skills


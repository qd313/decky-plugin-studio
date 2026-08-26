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

| **Status bar is missing in VS Code** | ★ | Bug — cause found | Reported 2026-08-26: the status bar shows in Cursor but not in VS Code. **Cause: the extension is not installed in VS Code at all.** `~/.vscode/extensions/` holds 19 extensions and none of them is DPS; `~/.cursor/extensions/` has two — `decky-plugin-studio-extension-0.1.2` and `-0.3.6`. Cursor and VS Code keep separate extension directories, so a VSIX installed in one is invisible to the other. Nothing is wrong with the status bar code: [statusBar.ts](../extension/src/ui/statusBar.ts) calls `show()` unconditionally in its constructor and `onStartupFinished` activation fires with or without a plugin workspace. **Fix is to install the VSIX in VS Code** — and while doing it, clean up the two stacked versions in Cursor, because it is not obvious which one is live. **Two real latent defects found while diagnosing, worth fixing regardless:** (1) the item is created with no `id` or `name`, so once a user hides it there is no findable entry in the status bar's right-click *Manage* menu to bring it back — it just looks gone forever; (2) the text is one long single item (`Decky v… | Preview ● | ● Tunnel | N ingest | ● Ollama | HW: …`) and VS Code silently drops right-aligned items that do not fit, so on a narrow window or a crowded bar it disappears with no warning. Splitting it, or collapsing to an icon plus a tooltip, removes a whole class of "it vanished" reports. |

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


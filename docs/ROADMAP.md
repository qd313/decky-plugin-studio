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


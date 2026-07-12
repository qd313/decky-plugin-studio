# Decky Plugin Studio — roadmap (deferred)



Star ratings follow bonsAI [roadmap](https://github.com/cantcurecancer/bonsAI) legend (effort/risk, 1 = lowest).



| Item | Stars | Status | Notes |

|------|-------|--------|-------|

| Native Steam Input / HID bridge in preview | ★★★★★★ | Deferred | W3C Gamepad only; see PREVIEW_LIMITATIONS |

| Gamescope / QAM compositing in preview | ★★★★★★ | Deferred | Requires CEF/chrome capture |

| Deck UI automation (`deck.openPlugin` hard) | ★★★★ | Deferred | v1 returns agent checklist only |

| Auto `.env` → `config.ts` on deploy | ★★★ | Plugin-specific | Use `.decky/preview.json` `preDeployCommand` |

| Pixel-perfect `@decky/ui` mocks | ★★★★ | Partial | v0.2 richer shims; on-device QA still required |



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


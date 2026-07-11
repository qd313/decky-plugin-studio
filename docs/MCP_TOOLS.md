# Decky Plugin Studio — MCP tool reference

For installing or building the extension, see [DEVELOPMENT.md](DEVELOPMENT.md).

> **Preview:** `preview.*` tools drive the in-IDE QAM preview, which is **very much beta**. Use `deck.deploy` + on-device QA for focus, layout, and Steam Input.

## Workspace config

Plugin repos may include [`.decky/preview.json`](../pack/.decky/preview.json):

| Field | Purpose |
|-------|---------|
| `rpcMode` | `discover` (default), `allowlist`, or `dev` |
| `rpcAllowlist` | Extra allowed RPC methods |
| `rpcDenylist` | Always blocked (`_main`, `_unload`, …) |
| `ipcTimeoutMs` | IPC wait for snapshot/RPC (default 120000) |
| `preDeployCommand` | Shell command before `deck.deploy` |
| `permissions` | Preview permission simulator map |

## deck.*

- **deck.configure** — `{ ip?, user?, port?, ingestPort? }`
- **deck.status** — tunnel, ingest, deck, ollama state
- **deck.startTunnel** / **deck.stopTunnel**
- **deck.probeIngest** / **deck.tailIngest** — `{ since?, lines?, hypothesisId? }`
- **deck.captureScreenshot** — `{ mode?: "auto"|"game"|"desktop", allowNonPluginUi?: boolean }`  
  Returns `{ path, bytes, mode, method }`. Composited methods preferred (`gamescope-atom`, `grim`). Open QAM + plugin first.
- **deck.record** — `{ seconds?, mode?, quality?: "compressed"|"full", allowNonPluginUi?: boolean }`  
  Returns `{ path, bytes, mode, method, seconds }`. Requires composited `pipewire-gamescope` or `wf-recorder` unless `allowNonPluginUi`. Artifacts: `<workspace>/recordings/`.
- **deck.installCaptureHelper** — `{ which?: "record"|"capture"|"both" }` — installs `studio-record` / `studio-capture` on Deck `~/.local/bin` (remote SSH only).
- **deck.deploy** — `{ mode?: "auto"|"local"|"remote" }` — unified copy manifest + retry

### Capture environment

| Variable | Purpose |
|----------|---------|
| `DECKY_STUDIO_WORKSPACE` | Plugin workspace root (artifacts, cwd) |
| `DECKY_STUDIO_ALLOW_STEAMOS_RW` | Set `0` to skip optional pacman/steamos-readonly on Deck |
| `BONSAI_ALLOW_STEAMOS_RW` | Legacy alias (still read) |

## plugin.*

- **plugin.detect** / **plugin.build** / **plugin.verifyZip**

## preview.*

- **preview.start** / **preview.stop** / **preview.status**
- **preview.health** — preview open + IPC readiness
- **preview.injectFocusEvent** — `{ direction }`
- **preview.setHardware** — partial hardware state
- **preview.runSequence** — `{ inputs, delayMs?, hwOverrides?, snapshot? }`
- **preview.callRpc** — `{ method, args? }` — discovery-based allowlist
- **preview.callTestHook** — `{ method, args? }` — `window.__deckyPreviewTestHooks`
- **preview.snapshotDom** — `{ selector? }`
- **preview.captureScreenshot** — `{ selector? }` → `screenshots/preview/`
- **preview.setHttpAllow** — `{ allowlist }`
- **preview.setPermissions** — `{ permissions: { hardware_control: false, … } }`
- **preview.readLog** — `{ lines? }`

## Preview test suite

After **Decky: Init Pack** and **Decky: Open Preview**:

```bash
node scripts/run-preview-suite.mjs --tier=smoke
```

See [device-qa-runbook.md](../docs/device-qa-runbook.md).

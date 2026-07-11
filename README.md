# Decky Plugin Studio

VS Code / Cursor extension for **Decky Loader** plugin development: live in-IDE QAM preview, MCP tools for build/deploy/debug on a real Steam Deck, composited screenshots and screen recordings, and an agent pack for your plugin repo.

> **Live preview is very much beta.** It is great for fast UI and RPC iteration, but focus, layout, Steam Input, and gamescope compositing still need on-device QA. See [Preview limitations](docs/PREVIEW_LIMITATIONS.md).

## What you get

| Feature | What it does |
|---------|----------------|
| **Live preview** | QAM-sized webview with HMR, virtual gamepad, hardware simulator, Python sidecar for real `main.py` RPC |
| **MCP tools** | Agents and commands for `deck.deploy`, `deck.captureScreenshot`, `deck.record`, preview suite, tunnel/ingest |
| **Composited capture** | Screenshots and recordings that include QAM + your plugin UI (not raw game-only kmsgrab) |
| **Init Pack** | Drops `AGENTS.md`, Cursor/VS Code MCP config, skills, and optional `scripts/` into your plugin repo |
| **Create New Plugin** | Clones decky-plugin-template, renames boilerplate, runs Init Pack |

## Install

1. Download the latest `.vsix` from [GitHub Releases](https://github.com/decky-plugin-studio/decky-plugin-studio/releases)
2. **Extensions** → **…** → **Install from VSIX…**
3. Reload the editor

The **status bar** (bottom-right) shows the installed version, preview/tunnel state, and ingest count.

## Quick start

### 1. Open a plugin workspace

Any folder with `plugin.json` and `main.py`. This repo includes [example-plugin/](example-plugin/) for smoke testing.

### 2. Configure your Deck (remote dev)

Use MCP **`deck.configure`** or create `.env` in your plugin repo:

```env
DECK_IP=192.168.x.x
DECK_USER=deck
```

Deck credentials are also stored under `~/.config/decky-plugin-studio/deck.env` when using MCP configure.

### 3. Init Pack

Command Palette → **`Decky: Init Pack`**

Copies agent guidance, MCP config, skills, and optional scripts (`record-deck`, `screenshot-deck`, preview suite).

### 4. Open preview (beta)

Command Palette → **`Decky: Open Preview`**

- Edit `src/` → Vite HMR in the QAM frame  
- Edit `main.py` → Python sidecar restarts with preserved state  

**Do not ship** based on preview alone — deploy to a Deck for focus and layout bugs.

### 5. Day-to-day loop

```
preview (fast UI) → plugin.build → deck.deploy → on-device QA
```

| Task | How |
|------|-----|
| Build plugin zip | MCP `plugin.build` or your `pnpm run build` |
| Deploy to Deck | MCP `deck.deploy` or **Decky: Deploy to Deck** |
| Screenshot (QAM + plugin) | MCP `deck.captureScreenshot` — open QAM + plugin first |
| Screen recording | MCP `deck.record` — open QAM + plugin before/during capture |
| Debug logs from Deck | `deck.startTunnel` → `deck.probeIngest` / `deck.tailIngest` |
| Agent automation | See [MCP tools](docs/MCP_TOOLS.md) |

**Artifacts** land in your plugin workspace: `screenshots/`, `recordings/`.

### 6. MCP in Cursor / VS Code

After Init Pack, your plugin repo’s `mcp.json` points at the extension’s MCP server. Tools are documented in [docs/MCP_TOOLS.md](docs/MCP_TOOLS.md).

Example agent flows:

- `deck.configure` → `plugin.build` → `deck.deploy` → `deck.captureScreenshot`
- `preview.start` → `preview.runSequence` for smoke tests
- `deck.record` with `{ seconds: 15, mode: "game", quality: "compressed" }`

## Capture prerequisites

For **game mode** screenshots and recordings:

1. Deploy your plugin (`deck.deploy`)
2. Open **QAM** on the Deck
3. Open **your plugin panel** and keep it visible during capture

Recordings use composited pipewire-gamescope (game) or wf-recorder (desktop). They **fail closed** if only game-plane capture would succeed — unless you pass `allowNonPluginUi: true`.

Optional: `deck.installCaptureHelper` installs `studio-record` / `studio-capture` to `~/.local/bin` on the Deck.

## Developing this extension

- **Branch model:** feature work on `develop` → merge to `main` with a version bump in `extension/package.json` → CI publishes a GitHub Release + VSIX
- Build locally: [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)

## More documentation

- [MCP tools reference](docs/MCP_TOOLS.md)
- [Preview limitations](docs/PREVIEW_LIMITATIONS.md) — beta preview vs on-device QA
- [Consumer sync (bonsAI & other plugins)](docs/MCP_CONSUMER_SYNC.md)
- [Device QA runbook](docs/device-qa-runbook.md)

## License

Apache-2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE).

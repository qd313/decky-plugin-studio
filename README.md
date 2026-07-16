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

Use MCP **`deck.configure`** or copy `.env.example` → `.env` in your plugin repo:

```bash
cp .env.example .env   # Linux / macOS
```

```powershell
Copy-Item .env.example .env   # Windows
```

```env
DECK_IP=192.168.x.x
DECK_USER=deck
```

Deck credentials are also stored under `~/.config/decky-plugin-studio/deck.env` when using MCP configure.

Run **`scripts/setup-dev.ps1`** (Windows) or **`scripts/setup-dev.sh`** (Linux) once per Deck to install SSH keys and passwordless sudo for deploy (dev-only — use **`revert-dev`** when finished).

### 3. Init Pack

Command Palette → **`Decky: Init Pack`**

Copies agent guidance, MCP config, skills, `.env.example`, and the full `scripts/` toolkit (build, setup-dev, capture, tunnel, watch-deploy).

### 4. Open preview (beta)

Command Palette → **`Decky: Open Preview`**

- Edit `src/` → Vite HMR in the QAM frame  
- Edit `main.py` → Python sidecar restarts with preserved state  

**Do not ship** based on preview alone — deploy to a Deck for focus and layout bugs.

### 5. Day-to-day loop

```
preview (fast UI) → build/deploy → on-device QA
```

| Task | MCP (agents) | Shell (human fallback) |
|------|----------------|------------------------|
| First-time Deck SSH/sudo | — | `scripts/setup-dev.ps1` / `scripts/setup-dev.sh` |
| Build + deploy | `plugin.build` → `deck.deploy` | `scripts/build.ps1` / `scripts/build.sh` |
| Deploy on same SteamOS machine | `deck.deploy` `{ mode: "local" }` | `scripts/build.sh local` |
| Watch + auto-deploy | — | `scripts/watch-deploy.ps1` / `scripts/watch-deploy.sh` |
| Screenshot (QAM + plugin) | `deck.captureScreenshot` | `scripts/screenshot-deck.ps1` / `scripts/screenshot-deck.sh` |
| Screen recording | `deck.record` | `scripts/record-deck.ps1` / `scripts/record-deck.sh` |
| Debug logs from Deck | `deck.startTunnel` → `deck.tailIngest` | `scripts/reverse-tunnel-deck-ingest.ps1` / `.sh` |
| Undo dev setup | — | `scripts/revert-dev.ps1` / `scripts/revert-dev.sh` |
| Release zip | `plugin.verifyZip` | `scripts/build.sh release` |

**Artifacts:** `screenshots/`, `recordings/`.

### 6. Shell scripts reference

After **Init Pack** (or in [example-plugin/](example-plugin/)), scripts live under **`scripts/`** in your plugin repo. Source templates: [`templates/scripts/`](templates/scripts/) in this repo.

| Purpose | Windows | Linux / macOS |
|---------|---------|---------------|
| Environment template | `.env.example` (repo root) | `.env.example` |
| Dev SSH + sudo setup | `scripts/setup-dev.ps1` | `scripts/setup-dev.sh` |
| Build + deploy | `scripts/build.ps1` | `scripts/build.sh` |
| Watch + deploy | `scripts/watch-deploy.ps1` | `scripts/watch-deploy.sh` |
| Screenshot Deck → PC | `scripts/screenshot-deck.ps1` | `scripts/screenshot-deck.sh` |
| Record Deck → PC | `scripts/record-deck.ps1` | `scripts/record-deck.sh` |
| Reverse tunnel (ingest) | `scripts/reverse-tunnel-deck-ingest.ps1` | `scripts/reverse-tunnel-deck-ingest.sh` |
| Revert dev setup | `scripts/revert-dev.ps1` | `scripts/revert-dev.sh` |
| Verify release zip | — | `scripts/verify-decky-plugin-zip.sh` |

**Security:** `setup-dev` grants broad passwordless sudo on the Deck (dev-only). Run **`revert-dev`** before handing the Deck back. Re-run **`setup-dev`** after SteamOS/client updates.

Init Pack **skips existing** script files — delete old `scripts/build.*` or choose **Overwrite all** to pick up template updates.

### 7. MCP in Cursor / VS Code

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

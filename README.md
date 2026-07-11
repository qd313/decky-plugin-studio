# Decky Plugin Studio

VS Code extension for **Decky Loader** plugin development (also works in Cursor): live in-IDE QAM preview, MCP tools for deck debug and deploy, and an agent pack laid down into your plugin repo.

## Install

Download the latest `.vsix` from [GitHub Releases](https://github.com/decky-plugin-studio/decky-plugin-studio/releases) (when published), or use a VSIX file you received.

In **VS Code** or **Cursor**:

1. Open **Extensions**
2. Click **…** (More Actions)
3. Choose **Install from VSIX…**
4. Select the `decky-plugin-studio-extension-*.vsix` file

Reload the editor if prompted.

## Getting started

### 1. Open a Decky plugin workspace

Open any folder that contains `plugin.json` and `main.py`. The repo includes [example-plugin/](example-plugin/) for smoke testing.

### 2. Initialize the agent pack

Command Palette → **`Decky: Init Pack`**

Copies agent guidance and MCP config into your plugin repo:

- **VS Code:** `.vscode/mcp.json` (Copilot MCP), `.github/copilot-instructions.md`
- **Cursor:** `mcp.json`, `.cursor/{rules,agents,skills,hooks}`, `AGENTS.md`

Both editors share the same Decky MCP server entry path after Init Pack.

### 3. Open preview

Command Palette → **`Decky: Open Preview`**

Edit `src/` — Vite HMR updates the QAM frame. Edit `main.py` — the Python sidecar restarts with state preserved under `~/.decky-plugin-studio/sandbox/`.

The preview panel includes a **virtual gamepad**, **hardware simulator** sliders, and a live console.

### 4. Create a new plugin (optional)

Command Palette → **`Decky: Create New Plugin`**

Clones the official [decky-plugin-template](https://github.com/SteamDeckHomebrew/decky-plugin-template), renames boilerplate identifiers, and runs **Init Pack** automatically.

## What's new in v0.2

- **Dynamic preview RPC** — discovers public methods from `main.py`; configure via `.decky/preview.json`
- **Generic preview test kit** — `run-preview-suite.mjs`, `preview.callTestHook`, `preview.health`
- **Deploy parity** — `py_modules/`, root `*.py` helpers, SSH retry
- **Permission simulator**, richer `@decky/ui` shims, hardened `deck.captureScreenshot`

See [ROADMAP.md](docs/ROADMAP.md) for deferred platform work.

## More documentation

- [MCP tools reference](docs/MCP_TOOLS.md) — `deck.*`, `plugin.*`, `preview.*` tools for Copilot and Cursor agents
- [Preview limitations](docs/PREVIEW_LIMITATIONS.md) — what the preview approximates vs on-device QA
- [VS Code smoke test](docs/VSCODE_SMOKE_TEST.md) — verify extension behavior in VS Code
- **Hardware simulator presets:** Idle, Hot Game, Thermal Throttle, Low Battery (preview panel or `preview.setHardware`)

## Developing this extension

See [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) for build, package, and deploy instructions.

## License

Apache-2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE) for bonsAI attribution.

# VS Code smoke test checklist

Use this checklist to verify **Decky Plugin Studio** in VS Code 1.85+ before claiming VS Code compatibility. The same VSIX also works in Cursor; repeat key steps there if you changed Init Pack or MCP wiring.

Current version: **0.3.11**. The in-IDE preview was retired on 2026-10-24, so there are no preview steps.

## Prerequisites

- VS Code 1.85+ installed with `code` on PATH
- Node.js 18+
- Python 3.10+ with `pyserial`, for the bridge scripts (`studio.doctor` checks it)
- Built VSIX: `pnpm run package:vsix` (after `pnpm run build`)

## 1. Install the VSIX

```powershell
code --install-extension extension/decky-plugin-studio-extension-0.3.11.vsix --force
```

Reload VS Code when prompted.

**Pass:** Extension appears under **Decky Plugin Studio** in the activity bar after opening a plugin workspace.

## 2. Open example plugin

```powershell
code example-plugin
```

**Pass:** Workspace contains `plugin.json` and `main.py`; extension activates (tree view visible).

## 3. Extension commands (no Deck required)

| Command | Expected result |
|---------|-----------------|
| **Decky: Refresh** | Tree and status bar update |
| **Decky: Create New Plugin** | Scaffolder prompts (cancel is fine) |
| **Decky: Doctor** | A list of setup checks, each ok, failing or unknown |
| **Decky: Show Studio Server Log** | The MCP server's output channel opens |

Deploy, tunnel, and screenshot commands require Deck network config; skip or expect a clear error if no Deck is configured.

## 4. Init Pack

Command Palette → **Decky: Init Pack** → overwrite or skip as needed.

**Pass:** These files exist in the plugin workspace:

- `.vscode/mcp.json` — MCP server entry uses absolute path to bundled `index.js` (not `__DECKY_MCP_ENTRY__`)
- `.github/copilot-instructions.md`
- `mcp.json` — Cursor MCP config (same resolved entry path)
- `.cursor/` — rules, agents, skills (Cursor enhancement layer)
- `AGENTS.md`

## 5. Copilot MCP (VS Code 1.99+ with Copilot)

1. Ensure GitHub Copilot and MCP support are enabled
2. Open **Chat** → MCP servers / tools panel
3. Confirm **decky-plugin-studio** registers after Init Pack

**Pass:** MCP tools such as `plugin.detect`, `deck.status` and `studio.doctor` are listed (exact UI varies by Copilot version).

If MCP does not appear, reload the window and verify `.vscode/mcp.json` paths point at an existing `index.js`.

## 6. Cursor regression (optional)

Install the same VSIX in Cursor and repeat steps 2–4.

**Pass:** Root `mcp.json` and `.cursor/*` still work; the tree behaves the same as in VS Code.

## Reporting failures

Note VS Code version, OS, command used, and extension log (**Help → Toggle Developer Tools → Console**). File issues with repro steps and smoke-test step number.

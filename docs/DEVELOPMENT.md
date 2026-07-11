# Development guide

Contributor documentation for building, packaging, and installing **Decky Plugin Studio** into VS Code (or Cursor).

For end-user install and daily use, see [README.md](../README.md).

## Branching and releases

- Feature work lands on **`develop`**
- Merge to **`main`** with a version bump in `extension/package.json` (and root `package.json`)
- GitHub Actions publishes a **Release** `vX.Y.Z` with the `.vsix` when a new version hits `main`

See [CHANGELOG.md](../CHANGELOG.md) for release notes.

## Prerequisites

- **Node.js** 18+
- **pnpm** 8+
- **Python** 3.10+ (preview sidecar only)

Install Python sidecar dependencies once:

```powershell
pip install -r preview-server/python/requirements.txt
```

## Deploy to VS Code (recommended)

One command installs dependencies, builds all packages, packages the VSIX, and installs it into VS Code:

```powershell
pnpm run deploy:vscode
```

This runs [scripts/deploy-to-vscode.mjs](../scripts/deploy-to-vscode.mjs), which:

1. `pnpm install`
2. `pnpm run build`
3. `pnpm run package:vsix` (bundles MCP server, preview-server, and pack into the VSIX)
4. `code --install-extension extension/*.vsix --force` (falls back to `cursor` or common Windows editor paths)

### Script flags

| Flag | Effect |
|------|--------|
| `--skip-install` | Build and package only; print VSIX path |
| `--skip-build` | Install the newest existing VSIX without rebuilding |

Examples:

```powershell
pnpm run deploy:vscode:build-only
node scripts/deploy-to-vscode.mjs --skip-build
```

### Deploy to Cursor (alias)

The same VSIX works in Cursor. For Cursor-first CLI resolution:

```powershell
pnpm run deploy:cursor
```

This runs [scripts/deploy-to-cursor.mjs](../scripts/deploy-to-cursor.mjs), which tries `cursor` before `code`.

### Manual install

If the CLI install fails:

```powershell
pnpm run build
pnpm run package:vsix
code --install-extension extension/decky-plugin-studio-extension-0.1.0.vsix --force
```

Or in VS Code / Cursor: **Extensions → … → Install from VSIX** and select the file under `extension/`.

## Build

```powershell
pnpm install
pnpm run build
```

Individual packages:

```powershell
pnpm run build:extension
pnpm run build:mcp
pnpm run build:preview
```

## Package artifacts

```powershell
pnpm run package:vsix   # extension/decky-plugin-studio-extension-*.vsix
pnpm run package:mcp    # mcp-server/decky-plugin-studio-mcp-*.tgz
```

## Repo layout

| Path | Purpose |
|------|---------|
| `extension/` | VSIX extension (commands, preview webview, tree, status bar) |
| `mcp-server/` | MCP tools (deck, plugin, preview, ingest) |
| `preview-server/` | Vite Decky shims + Python sidecar |
| `pack/` | Agent pack copied by **Decky: Init Pack** (`.vscode/mcp.json`, `.cursor/*`, etc.) |
| `example-plugin/` | Minimal plugin for preview smoke tests |
| `templates/` | Scaffolder rename manifest |

## CI

GitHub Actions builds the VSIX on version tags: [.github/workflows/build-vsix.yml](../.github/workflows/build-vsix.yml).

## Related docs

- [MCP_TOOLS.md](MCP_TOOLS.md) — MCP tool reference for plugin workspaces
- [PREVIEW_LIMITATIONS.md](PREVIEW_LIMITATIONS.md) — what the in-IDE preview can and cannot do
- [VSCODE_SMOKE_TEST.md](VSCODE_SMOKE_TEST.md) — VS Code verification checklist

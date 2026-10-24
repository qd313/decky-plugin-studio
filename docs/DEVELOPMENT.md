# Development guide

Contributor documentation for building, packaging, and installing **Decky Plugin Studio** into VS Code (or Cursor).

For end-user install and daily use, see [README.md](../README.md).

## Branching and releases

- Feature work lands on a feature branch
- Merge to **`main`** with a version bump in `extension/package.json` (and root `package.json`)
- Root, `extension` and `mcp-server` are pinned together, and `SERVER_INFO` in `mcp-server/src/index.ts` must move with them, or the server reports a stale number over MCP `serverInfo` (it did once, at 0.3.6, while the extension was on 0.3.7)
- Bump the version for every install into a running editor, not only for releases: the editor holds the installed extension directory open, so the same version fails to reinstall over itself (`EBUSY`), while a new number installs alongside it. Each install leaves the previous version on disk -- the highest wins, so it is harmless -- but `code --list-extensions --show-versions` is worth a look before a release
- Cut the `## [Unreleased]` entries in `CHANGELOG.md` into a `## [x.y.z]` section before merging: the release workflow extracts that section as the GitHub Release body, and falls back to auto-generated notes without it
- GitHub Actions publishes a **Release** `vX.Y.Z` with the `.vsix` when a new version hits `main` (and the tag does not already exist), or when a `v*` tag is pushed; a `workflow_dispatch` run with `publish_github_release` left off builds the VSIX as an artifact without publishing

See [CHANGELOG.md](../CHANGELOG.md) for release notes.

## Prerequisites

- **Node.js** 18+
- **pnpm** 8+


## Deploy to VS Code (recommended)

One command installs dependencies, builds all packages, packages the VSIX, and installs it into VS Code:

```powershell
pnpm run deploy:vscode
```

This runs [scripts/deploy-to-vscode.mjs](../scripts/deploy-to-vscode.mjs), which:

1. `pnpm install`
2. `pnpm run build`
3. `pnpm run package:vsix` (bundles the MCP server and the pack into the VSIX)
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
code --install-extension extension/decky-plugin-studio-extension-0.3.11.vsix --force
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
```

## Package artifacts

```powershell
pnpm run package:vsix   # extension/decky-plugin-studio-extension-*.vsix
pnpm run package:mcp    # mcp-server/decky-plugin-studio-mcp-*.tgz
```

## Repo layout

| Path | Purpose |
|------|---------|
| `extension/` | VSIX extension (commands, tree, status bar) |
| `mcp-server/` | MCP tools (deck, plugin, ingest) |
| `pack/` | Agent pack copied by **Decky: Init Pack** (`.vscode/mcp.json`, `.cursor/*`, etc.) |
| `bridge/` | The ESP32 controller bridge: firmware, and the press, chord and virtual-pad scripts under `bridge/tools/` |
| `scripts/standin/` | Setup scripts for stand-in machines (Windows Decky, VMs, a Bazzite host) |
| `example-plugin/` | Minimal example plugin |
| `templates/` | Scaffolder rename manifest |

## Stopping and arming the rig

```powershell
pnpm stop   # stop all Deck automation now (the killswitch)
pnpm arm    # re-arm it; only a human should run this
```

The status bar and the **Decky: Stop All Deck Automation** / **Decky: Arm Deck Automation** commands do the same.

## CI

GitHub Actions builds the VSIX ([.github/workflows/build-vsix.yml](../.github/workflows/build-vsix.yml)) on a `v*` tag, on a push to `main` that changes `extension/package.json` or `package.json`, and on a manual run.

## Related docs

- [MCP_TOOLS.md](MCP_TOOLS.md) — MCP tool reference for plugin workspaces
- [PREVIEW_LIMITATIONS.md](PREVIEW_LIMITATIONS.md) — note: the in-IDE preview was retired
- [VSCODE_SMOKE_TEST.md](VSCODE_SMOKE_TEST.md) — VS Code verification checklist

#!/usr/bin/env node
/**
 * Shared build + VSIX install logic for VS Code and Cursor deploy scripts.
 */
import { spawnSync } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = path.join(__dirname, "..");
export const extensionDir = path.join(repoRoot, "extension");

const isWin = process.platform === "win32";
const shell = isWin ? "cmd.exe" : "/bin/sh";

export function run(cmd, cwd = repoRoot) {
  console.log(`\n> ${cmd}\n`);
  const result = spawnSync(cmd, {
    cwd,
    stdio: "inherit",
    shell,
  });
  if (result.status !== 0) {
    console.error(`Command failed (exit ${result.status}): ${cmd}`);
    process.exit(result.status ?? 1);
  }
}

export function findVsix() {
  if (!fs.existsSync(extensionDir)) {
    console.error(`Extension directory not found: ${extensionDir}`);
    process.exit(1);
  }
  const files = fs
    .readdirSync(extensionDir)
    .filter((f) => f.endsWith(".vsix"))
    .map((f) => ({
      name: f,
      mtime: fs.statSync(path.join(extensionDir, f)).mtimeMs,
    }))
    .sort((a, b) => b.mtime - a.mtime);

  if (files.length === 0) {
    console.error("No .vsix found in extension/. Run build/package first.");
    process.exit(1);
  }
  return path.join(extensionDir, files[0].name);
}

function resolveEditorClis(prefer) {
  const codeCandidates = [];
  const cursorCandidates = [];

  if (isWin) {
    const localAppData = process.env.LOCALAPPDATA ?? "";
    const programFiles = process.env.ProgramFiles ?? "C:\\Program Files";

    codeCandidates.push(
      path.join(localAppData, "Programs", "Microsoft VS Code", "bin", "code.cmd"),
      path.join(programFiles, "Microsoft VS Code", "bin", "code.cmd")
    );
    cursorCandidates.push(
      path.join(localAppData, "Programs", "cursor", "resources", "app", "bin", "cursor.cmd"),
      path.join(localAppData, "cursor", "resources", "app", "bin", "cursor.cmd"),
      path.join(localAppData, "Programs", "Cursor", "resources", "app", "bin", "cursor.cmd")
    );
  }

  const codeClis = ["code", ...codeCandidates.filter((p) => fs.existsSync(p))];
  const cursorClis = ["cursor", ...cursorCandidates.filter((p) => fs.existsSync(p))];

  /*
   * ONE editor's CLIs, never the other's.
   *
   * This used to return `[...codeClis, ...cursorClis]` for a VS Code deploy and
   * the reverse for Cursor -- so a failure in the requested editor silently fell
   * through and installed into the OTHER one, then printed "Installed via:
   * cursor" and exited 0. That is not a fallback between ways of reaching one
   * editor, it is a fallback between editors, and it turns a failed deploy into
   * a successful-looking deploy of the wrong thing.
   *
   * It happened on 2026-08-27: `pnpm deploy:vscode` could not replace a
   * same-version directory that a running VS Code held open (EBUSY), fell
   * through to a not-running Cursor, and reported success. VS Code kept the old
   * build and nothing said so.
   *
   * The candidates below are still a list, because a single editor's CLI can
   * live in several places. They are all the same editor.
   */
  return prefer === "cursor" ? cursorClis : codeClis;
}

export function installVsix(vsixPath, { prefer = "vscode" } = {}) {
  const quoted = isWin ? `"${vsixPath}"` : `"${vsixPath.replace(/"/g, '\\"')}"`;
  const clis = resolveEditorClis(prefer);
  const editorLabel = prefer === "cursor" ? "Cursor" : "VS Code";

  for (const cli of clis) {
    const cmd = isWin && cli.includes(" ")
      ? `"${cli}" --install-extension ${quoted} --force`
      : `${cli} --install-extension ${quoted} --force`;

    console.log(`\nTrying: ${cli} --install-extension ... --force\n`);
    const result = spawnSync(cmd, { stdio: "inherit", shell });

    if (result.status === 0) {
      console.log(`\nInstalled via: ${cli}`);
      console.log(`VSIX: ${vsixPath}`);
      return;
    }
  }

  console.error(`\nFailed to install the VSIX into ${editorLabel}. Tried: ${clis.join(", ")}`);
  console.error(`It was NOT installed anywhere else -- this script only targets ${editorLabel}.`);

  /*
   * The failure that actually happens, and its actual cause.
   *
   * Installing a version over ITSELF makes the editor rename the existing
   * extension directory, which it cannot do while it holds those files open.
   * A different version number installs into a fresh directory and needs no
   * restart at all -- so the fix is usually a version bump, not a restart.
   */
  console.error("");
  console.error(`If the output above says EBUSY or "Please restart", ${editorLabel} is running`);
  console.error("and already holds this exact version's extension directory. Either:");
  console.error("  - bump the version (a new version installs alongside, no restart needed), or");
  console.error(`  - close ${editorLabel} and run this again.`);
  console.error("");
  console.error(`Manual install: ${editorLabel} → Extensions → … → Install from VSIX`);
  console.error(`VSIX path: ${vsixPath}`);
  process.exit(1);
}

export function deploy({ prefer = "vscode", skipInstall = false, skipBuild = false } = {}) {
  if (!skipBuild) {
    run("pnpm install");
    run("pnpm run build");
    run("pnpm run package:vsix");
  }

  const vsixPath = findVsix();
  console.log(`\nVSIX: ${vsixPath}`);

  if (skipInstall) {
    console.log("--skip-install: build/package complete; not installing.");
    process.exit(0);
  }

  installVsix(vsixPath, { prefer });
}

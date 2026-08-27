import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const extRoot = path.join(__dirname, "..");
const repoRoot = path.join(extRoot, "..");
const resources = path.join(extRoot, "resources");

const SKIP = new Set(["node_modules", ".git", "dist", "__pycache__", ".hw-state.json", "package-lock.json"]);

function cpFiltered(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) cpFiltered(s, d);
    else fs.copyFileSync(s, d);
  }
}

fs.rmSync(resources, { recursive: true, force: true });
fs.mkdirSync(resources, { recursive: true });

const mcpDest = path.join(resources, "mcp-server");
cpFiltered(path.join(repoRoot, "mcp-server", "dist"), path.join(mcpDest, "dist"));
fs.cpSync(path.join(repoRoot, "mcp-server", "dist", "scripts"), path.join(mcpDest, "dist", "scripts"), { recursive: true });

/*
 * The MCP server needs its manifest and its runtime dependencies, and for a
 * long time it shipped with neither.
 *
 * Only `dist/` was copied, so an installed VSIX contained a server that could
 * not start: the first import of `pngjs` threw ERR_MODULE_NOT_FOUND and the
 * process died before reading a single request. The extension swallowed that
 * ("dev mode without built MCP"), so the status bar simply rendered its
 * all-false defaults forever and every Studio tool was dead. It looked like a
 * network problem. It was a packaging problem, and it had never worked.
 *
 * package.json matters on its own: without `"type": "module"` Node only guesses
 * ESM by sniffing syntax, which it warns about and is not obliged to keep doing.
 */
fs.copyFileSync(path.join(repoRoot, "mcp-server", "package.json"), path.join(mcpDest, "package.json"));

console.log("Installing MCP server dependencies for VSIX bundle...");
const mcpInstall = spawnSync("npm", ["install", "--omit=dev", "--no-audit", "--no-fund"], {
  cwd: mcpDest,
  stdio: "inherit",
  shell: true,
});
if (mcpInstall.status !== 0) {
  console.error("Failed to install MCP server dependencies into extension/resources/mcp-server");
  process.exit(1);
}

const previewDest = path.join(resources, "preview-server");
cpFiltered(path.join(repoRoot, "preview-server"), previewDest);
fs.cpSync(path.join(repoRoot, "preview-server", "dist"), path.join(previewDest, "dist"), { recursive: true });

console.log("Installing preview-server dependencies for VSIX bundle...");
const npmInstall = spawnSync("npm", ["install", "--include=dev", "--no-audit", "--no-fund"], {
  cwd: previewDest,
  stdio: "inherit",
  shell: true,
});
if (npmInstall.status !== 0) {
  console.error("Failed to install preview-server dependencies into extension/resources/preview-server");
  process.exit(1);
}
const reactDomClient = path.join(previewDest, "node_modules", "react-dom", "client.js");
if (!fs.existsSync(reactDomClient)) {
  console.error(`Missing bundled preview dependency: ${reactDomClient}`);
  process.exit(1);
}

cpFiltered(path.join(repoRoot, "pack"), path.join(resources, "pack"));

/*
 * The bridge board's helper scripts.
 *
 * Bundled for the killswitch. findBridgeTool() walks up from the running server
 * looking for `bridge/tools/<name>`, and from resources/mcp-server/dist/deck it
 * reaches resources/ -- so putting them here is what makes them findable in an
 * installed extension. Without this the killswitch's release step reports
 * "pad.py not found" every time it runs from a VSIX, which is honest but means
 * the board is only ever neutralised by the firmware watchdog rather than being
 * told to let go.
 *
 * That case is real and not rare: the agent driving the Deck runs the server
 * from a source checkout (see mcp.json), while the status bar the human clicks
 * belongs to the installed extension. The latch crosses that gap on its own --
 * it is a file -- but the release has to be able to run on the side the human
 * pressed the button.
 *
 * tools/ only. The firmware sources are not needed at runtime, and __pycache__
 * is already filtered.
 */
fs.mkdirSync(path.join(resources, "bridge"), { recursive: true });
cpFiltered(path.join(repoRoot, "bridge", "tools"), path.join(resources, "bridge", "tools"));

const padTool = path.join(resources, "bridge", "tools", "pad.py");
if (!fs.existsSync(padTool)) {
  console.error(`Missing bundled bridge tool: ${padTool}`);
  console.error("The killswitch could not release the board from an installed extension.");
  process.exit(1);
}

/*
 * Prove the bundled server actually starts.
 *
 * A dependency check would have caught the pngjs omission, but only that one.
 * Starting the thing and requiring an answer catches the whole class: a missing
 * dep, a bad module type, a top-level throw, a dist that was never rebuilt.
 * This runs against exactly what ships, which is the only version whose failure
 * a user ever sees.
 */
console.log("Smoke-testing the bundled MCP server...");
const smoke = spawnSync(
  process.execPath,
  [path.join(__dirname, "smoke-mcp-bundle.mjs"), path.join(mcpDest, "dist", "index.js"), extRoot],
  { stdio: "inherit" },
);
if (smoke.status !== 0) {
  console.error("The bundled MCP server does not start. Packaging it would ship a dead extension.");
  process.exit(1);
}

console.log("Bundled MCP server, preview-server, pack, and bridge tools into extension/resources/");

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

cpFiltered(path.join(repoRoot, "mcp-server", "dist"), path.join(resources, "mcp-server", "dist"));
fs.cpSync(path.join(repoRoot, "mcp-server", "dist", "scripts"), path.join(resources, "mcp-server", "dist", "scripts"), { recursive: true });

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

console.log("Bundled MCP server, preview-server, and pack into extension/resources/");

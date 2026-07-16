import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");

function copyRecursive(src, dest) {
  if (!fs.existsSync(src)) return;
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src)) {
      copyRecursive(path.join(src, entry), path.join(dest, entry));
    }
    return;
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

const distScripts = path.join(root, "dist", "scripts");
if (fs.existsSync(distScripts)) {
  fs.rmSync(distScripts, { recursive: true, force: true });
}
copyRecursive(path.join(root, "..", "templates", "scripts"), distScripts);

const syncScript = path.join(root, "scripts", "sync-rpc-allowlist.mjs");
if (fs.existsSync(syncScript)) {
  fs.mkdirSync(path.join(root, "dist", "scripts"), { recursive: true });
  fs.copyFileSync(syncScript, path.join(root, "dist", "scripts", "sync-rpc-allowlist.mjs"));
}

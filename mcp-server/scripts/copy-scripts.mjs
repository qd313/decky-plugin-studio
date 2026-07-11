import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");

function copyDir(src, dest) {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dest, { recursive: true });
  for (const f of fs.readdirSync(src)) {
    fs.copyFileSync(path.join(src, f), path.join(dest, f));
  }
}

copyDir(path.join(root, "src", "scripts"), path.join(root, "dist", "scripts"));

const syncScript = path.join(root, "scripts", "sync-rpc-allowlist.mjs");
if (fs.existsSync(syncScript)) {
  fs.mkdirSync(path.join(root, "dist", "scripts"), { recursive: true });
  fs.copyFileSync(syncScript, path.join(root, "dist", "scripts", "sync-rpc-allowlist.mjs"));
}

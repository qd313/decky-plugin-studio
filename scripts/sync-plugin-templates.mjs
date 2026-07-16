#!/usr/bin/env node
/**
 * Copy templates/scripts + .env.example into example-plugin/ for maintainer sync.
 * Usage: node scripts/sync-plugin-templates.mjs
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, "..");
const templatesScripts = path.join(repoRoot, "templates", "scripts");
const templatesEnv = path.join(repoRoot, "templates", ".env.example");
const exampleRoot = path.join(repoRoot, "example-plugin");
const exampleScripts = path.join(exampleRoot, "scripts");
const exampleEnv = path.join(exampleRoot, ".env.example");

function copyRecursive(src, dest) {
  if (!fs.existsSync(src)) {
    console.error(`Missing: ${src}`);
    process.exit(1);
  }
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

if (fs.existsSync(exampleScripts)) {
  fs.rmSync(exampleScripts, { recursive: true, force: true });
}
copyRecursive(templatesScripts, exampleScripts);
fs.copyFileSync(templatesEnv, exampleEnv);
console.log(`Synced templates → ${path.relative(repoRoot, exampleRoot)}/scripts/ and .env.example`);

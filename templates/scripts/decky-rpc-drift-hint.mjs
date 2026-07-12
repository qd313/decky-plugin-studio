#!/usr/bin/env node
/** Scan src/ and main.py for RPC drift (standalone — no MCP required). */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

const CALL_RE = /\bcall\s*\(\s*["']([a-zA-Z_][\w]*)["']/g;

function discoverBackend(mainPy) {
  if (!fs.existsSync(mainPy)) return new Set();
  const src = fs.readFileSync(mainPy, "utf8");
  const m = src.match(/class\s+Plugin\s*(?:\([^)]*\))?\s*:/);
  if (!m || m.index === undefined) return new Set();
  const body = src.slice(m.index);
  const methods = new Set();
  for (const line of body.split("\n")) {
    const hit = line.match(/^\s+(?:async\s+)?def\s+([a-zA-Z_][\w]*)\s*\(/);
    if (hit && !hit[1].startsWith("_")) methods.add(hit[1]);
    if (line.trim() && !line.startsWith(" ") && !line.startsWith("\t") && !line.startsWith("#") && line !== body.split("\n")[0]) break;
  }
  return methods;
}

function walk(dir, out) {
  if (!fs.existsSync(dir)) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === "dist") continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(tsx?|jsx?)$/.test(e.name)) out.push(p);
  }
}

function discoverFrontend() {
  const files = [];
  walk(path.join(root, "src"), files);
  const methods = new Set();
  for (const f of files) {
    const content = fs.readFileSync(f, "utf8");
    let m;
    const re = new RegExp(CALL_RE.source, "g");
    while ((m = re.exec(content)) !== null) methods.add(m[1]);
  }
  return methods;
}

const backend = discoverBackend(path.join(root, "main.py"));
const frontend = discoverFrontend();
const backendOnly = [...backend].filter((m) => !frontend.has(m)).sort();
const frontendOnly = [...frontend].filter((m) => !backend.has(m)).sort();

if (!backendOnly.length && !frontendOnly.length) {
  console.log("decky-rpc-drift: OK (no drift)");
  process.exit(0);
}

console.log("decky-rpc-drift: mismatch detected — run plugin.diffRpc (MCP)");
if (backendOnly.length) console.log("  backendOnly:", backendOnly.join(", "));
if (frontendOnly.length) console.log("  frontendOnly:", frontendOnly.join(", "));
process.exit(0);

import fs from "fs";
import path from "path";
import { getWorkspaceRoot } from "../config.js";
import { discoverWorkspaceRpcMethods } from "./rpcDiscover.js";
import { resolveRpcAllowlist } from "./rpcAllowlist.js";

const CALL_RE = /\bcall\s*\(\s*["']([a-zA-Z_][\w]*)["']/g;
const SERVER_CALL_RE = /ServerAPI\.callPluginMethod\s*\(\s*["']([a-zA-Z_][\w]*)["']/g;

function walkSourceFiles(dir: string, out: string[]): void {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkSourceFiles(full, out);
    } else if (/\.(tsx?|jsx?)$/.test(entry.name)) {
      out.push(full);
    }
  }
}

export function discoverFrontendRpcMethods(workspaceRoot?: string): string[] {
  const root = workspaceRoot ?? getWorkspaceRoot();
  const srcDir = path.join(root, "src");
  const files: string[] = [];
  walkSourceFiles(srcDir, files);

  const methods = new Set<string>();
  for (const file of files) {
    const content = fs.readFileSync(file, "utf8");
    let m: RegExpExecArray | null;
    const re1 = new RegExp(CALL_RE.source, "g");
    const re2 = new RegExp(SERVER_CALL_RE.source, "g");
    while ((m = re1.exec(content)) !== null) methods.add(m[1]);
    while ((m = re2.exec(content)) !== null) methods.add(m[1]);
  }
  return [...methods].sort();
}

export function diffRpc(workspaceRoot?: string): {
  backendOnly: string[];
  frontendOnly: string[];
  matched: string[];
  previewDenied?: string[];
} {
  const root = workspaceRoot ?? getWorkspaceRoot();
  const backend = new Set(discoverWorkspaceRpcMethods(root));
  const frontend = new Set(discoverFrontendRpcMethods(root));

  const matched: string[] = [];
  const backendOnly: string[] = [];
  const frontendOnly: string[] = [];

  for (const m of backend) {
    if (frontend.has(m)) matched.push(m);
    else backendOnly.push(m);
  }
  for (const m of frontend) {
    if (!backend.has(m)) frontendOnly.push(m);
  }

  matched.sort();
  backendOnly.sort();
  frontendOnly.sort();

  const snap = resolveRpcAllowlist(root);
  const deniedFromFrontend = [...frontend].filter(
    (m) =>
      backend.has(m) &&
      !snap.allowed.includes(m) &&
      !snap.allowed.includes("*") &&
      snap.rpcMode !== "dev"
  );

  return {
    backendOnly,
    frontendOnly,
    matched,
    previewDenied: deniedFromFrontend.length ? deniedFromFrontend.sort() : undefined,
  };
}

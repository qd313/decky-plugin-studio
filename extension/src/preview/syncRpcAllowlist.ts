import * as cp from "child_process";
import * as path from "path";
import * as fs from "fs";
import { getMcpServerEntry } from "../paths";

/** Write preview-rpc.json to sandbox before sidecar starts. */
export function syncRpcAllowlistForWorkspace(workspaceRoot: string): void {
  const mcpRoot = path.dirname(path.dirname(getMcpServerEntry()));
  const script = path.join(mcpRoot, "scripts", "sync-rpc-allowlist.mjs");
  if (fs.existsSync(script)) {
    try {
      cp.execFileSync(process.execPath, [script, workspaceRoot], {
        env: { ...process.env, DECKY_STUDIO_WORKSPACE: workspaceRoot },
        stdio: "pipe",
        encoding: "utf8",
      });
      return;
    } catch {
      /* fall through to inline */
    }
  }
  inlineSyncRpcAllowlist(workspaceRoot);
}

function inlineSyncRpcAllowlist(workspaceRoot: string): void {
  const mainPy = path.join(workspaceRoot, "main.py");
  const methods = discoverMethods(mainPy);
  const home = process.env.HOME || process.env.USERPROFILE || "";
  const sandbox = path.join(
    home,
    ".decky-plugin-studio",
    "sandbox",
    path.basename(workspaceRoot)
  );
  const out = {
    rpcMode: "discover",
    allowed: methods,
    denylist: ["_main", "_unload", "_migration"],
    discovered: methods,
    generatedAt: Date.now(),
  };
  fs.mkdirSync(sandbox, { recursive: true });
  fs.writeFileSync(path.join(sandbox, "preview-rpc.json"), JSON.stringify(out, null, 2), "utf8");
}

function discoverMethods(mainPyPath: string): string[] {
  if (!fs.existsSync(mainPyPath)) return [];
  const src = fs.readFileSync(mainPyPath, "utf8");
  const methods = new Set<string>();
  const re = /^\s+(?:async\s+)?def\s+([a-zA-Z_][\w]*)\s*\(/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    if (!m[1].startsWith("_")) methods.add(m[1]);
  }
  return [...methods].sort();
}

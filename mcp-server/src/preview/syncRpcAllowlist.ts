import fs from "fs";
import path from "path";
import { getWorkspaceRoot } from "../config.js";
import { resolveRpcAllowlist, type RpcAllowlistSnapshot } from "./rpcAllowlist.js";

export function getSandboxRoot(workspaceRoot?: string): string {
  const root = workspaceRoot ?? getWorkspaceRoot();
  const home = process.env.HOME || process.env.USERPROFILE || "";
  return path.join(home, ".decky-plugin-studio", "sandbox", path.basename(root));
}

export function getRpcAllowlistJsonPath(workspaceRoot?: string): string {
  return path.join(getSandboxRoot(workspaceRoot), "preview-rpc.json");
}

export function syncRpcAllowlistToSandbox(workspaceRoot?: string): RpcAllowlistSnapshot {
  const snap = resolveRpcAllowlist(workspaceRoot);
  const outPath = getRpcAllowlistJsonPath(workspaceRoot);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(snap, null, 2), "utf8");
  return snap;
}

export function readSandboxRpcAllowlist(workspaceRoot?: string): RpcAllowlistSnapshot | null {
  const outPath = getRpcAllowlistJsonPath(workspaceRoot);
  if (!fs.existsSync(outPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(outPath, "utf8")) as RpcAllowlistSnapshot;
  } catch {
    return null;
  }
}

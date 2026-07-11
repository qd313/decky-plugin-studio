import { loadPreviewConfig } from "./previewConfig.js";
import { discoverWorkspaceRpcMethods } from "./rpcDiscover.js";

export type RpcAllowlistSnapshot = {
  rpcMode: string;
  allowed: string[];
  denylist: string[];
  discovered: string[];
  generatedAt: number;
};

export function resolveRpcAllowlist(workspaceRoot?: string): RpcAllowlistSnapshot {
  const config = loadPreviewConfig(workspaceRoot);
  const discovered = discoverWorkspaceRpcMethods(workspaceRoot);
  const deny = new Set(config.rpcDenylist);

  if (config.rpcMode === "dev") {
    console.warn(
      "[decky-plugin-studio] preview RPC mode is 'dev' — all methods allowed except denylist"
    );
    return {
      rpcMode: "dev",
      allowed: ["*"],
      denylist: [...deny],
      discovered,
      generatedAt: Date.now(),
    };
  }

  if (config.rpcMode === "allowlist") {
    const allowed = config.rpcAllowlist.filter((m) => !deny.has(m) && !m.startsWith("_"));
    return {
      rpcMode: "allowlist",
      allowed,
      denylist: [...deny],
      discovered,
      generatedAt: Date.now(),
    };
  }

  // discover (default): discovered + explicit allowlist extras
  const merged = new Set<string>();
  for (const m of discovered) {
    if (!deny.has(m) && !m.startsWith("_")) merged.add(m);
  }
  for (const m of config.rpcAllowlist) {
    if (!deny.has(m) && !m.startsWith("_")) merged.add(m);
  }

  return {
    rpcMode: "discover",
    allowed: [...merged].sort(),
    denylist: [...deny],
    discovered,
    generatedAt: Date.now(),
  };
}

export function isPreviewRpcAllowed(method: string, workspaceRoot?: string): boolean {
  const snap = resolveRpcAllowlist(workspaceRoot);
  if (snap.denylist.includes(method) || method.startsWith("_")) return false;
  if (snap.rpcMode === "dev") return true;
  if (snap.allowed.includes("*")) return true;
  return snap.allowed.includes(method);
}

/** @deprecated use isPreviewRpcAllowed */
export function isPreviewRpcAllowedLegacy(method: string): boolean {
  return isPreviewRpcAllowed(method);
}

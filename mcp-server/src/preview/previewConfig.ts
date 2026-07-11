import fs from "fs";
import path from "path";
import { getWorkspaceRoot } from "../config.js";

export type RpcMode = "discover" | "allowlist" | "dev";

export type PreviewConfig = {
  rpcMode: RpcMode;
  rpcAllowlist: string[];
  rpcDenylist: string[];
  ipcTimeoutMs: number;
  preDeployCommand?: string;
  permissions: Record<string, boolean>;
};

const DEFAULT_DENYLIST = ["_main", "_unload", "_migration"];

const DEFAULT_CONFIG: PreviewConfig = {
  rpcMode: "discover",
  rpcAllowlist: [],
  rpcDenylist: [...DEFAULT_DENYLIST],
  ipcTimeoutMs: 120_000,
  permissions: {
    hardware_control: true,
    filesystem: true,
    network: true,
    clipboard: true,
    audio: true,
    notifications: true,
  },
};

export function getPreviewConfigPath(workspaceRoot?: string): string {
  return path.join(workspaceRoot ?? getWorkspaceRoot(), ".decky", "preview.json");
}

export function loadPreviewConfig(workspaceRoot?: string): PreviewConfig {
  const configPath = getPreviewConfigPath(workspaceRoot);
  if (!fs.existsSync(configPath)) {
    return { ...DEFAULT_CONFIG, rpcDenylist: [...DEFAULT_DENYLIST] };
  }
  try {
    const raw = JSON.parse(fs.readFileSync(configPath, "utf8")) as Partial<PreviewConfig>;
    return {
      ...DEFAULT_CONFIG,
      ...raw,
      rpcAllowlist: raw.rpcAllowlist ?? DEFAULT_CONFIG.rpcAllowlist,
      rpcDenylist: [...new Set([...DEFAULT_DENYLIST, ...(raw.rpcDenylist ?? [])])],
      permissions: { ...DEFAULT_CONFIG.permissions, ...(raw.permissions ?? {}) },
    };
  } catch {
    return { ...DEFAULT_CONFIG, rpcDenylist: [...DEFAULT_DENYLIST] };
  }
}

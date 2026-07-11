import * as cp from "child_process";
import * as path from "path";
import * as fs from "fs";
import { getMcpServerEntry, getRepoRoot } from "../paths";

export interface McpState {
  previewRunning: boolean;
  previewUrl?: string;
  tunnelRunning: boolean;
  tunnelPid?: number;
  ingestCount: number;
  deckReachable: boolean;
  ollamaReachable: boolean;
  hwPreset: string;
}

let mcpProcess: cp.ChildProcess | null = null;
let state: McpState = {
  previewRunning: false,
  tunnelRunning: false,
  ingestCount: 0,
  deckReachable: false,
  ollamaReachable: false,
  hwPreset: "Idle",
};

const pendingRequests = new Map<
  number,
  { resolve: (v: unknown) => void; reject: (e: Error) => void }
>();
let requestId = 0;
let buffer = "";

export function getMcpState(): McpState {
  return { ...state };
}

export function updateMcpState(partial: Partial<McpState>): void {
  state = { ...state, ...partial };
}

function sendRequest(method: string, params: Record<string, unknown>): Promise<unknown> {
  return new Promise((resolve, reject) => {
    if (!mcpProcess?.stdin?.writable) {
      reject(new Error("MCP server not running"));
      return;
    }
    const id = ++requestId;
    pendingRequests.set(id, { resolve, reject });
    const msg = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
    mcpProcess.stdin.write(msg);
    setTimeout(() => {
      if (pendingRequests.has(id)) {
        pendingRequests.delete(id);
        reject(new Error(`MCP request timeout: ${method}`));
      }
    }, 120_000);
  });
}

function handleLine(line: string): void {
  if (!line.trim()) return;
  try {
    const msg = JSON.parse(line);
    if (msg.id && pendingRequests.has(msg.id)) {
      const pending = pendingRequests.get(msg.id)!;
      pendingRequests.delete(msg.id);
      if (msg.error) pending.reject(new Error(msg.error.message ?? "MCP error"));
      else pending.resolve(msg.result);
    }
    if (msg.method === "notifications/state") {
      updateMcpState(msg.params ?? {});
    }
  } catch {
    /* ignore non-json */
  }
}

export async function spawnMcpProcess(): Promise<void> {
  if (mcpProcess) return;

  const entry = getMcpServerEntry();
  const devEntry = path.join(getRepoRoot(), "mcp-server", "src", "index.ts");
  const useTs = !fs.existsSync(entry) && fs.existsSync(devEntry);

  const cmd = useTs ? "npx" : process.execPath;
  const args = useTs
    ? ["tsx", devEntry]
    : [entry];

  const workspace = process.env.VSCODE_CWD ?? process.cwd();

  mcpProcess = cp.spawn(cmd, args, {
    cwd: getRepoRoot(),
    env: {
      ...process.env,
      DECKY_STUDIO_WORKSPACE: workspace,
      DECKY_STUDIO_REPO: getRepoRoot(),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  mcpProcess.stdout?.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) handleLine(line);
  });

  mcpProcess.stderr?.on("data", (chunk: Buffer) => {
    console.error("[decky-mcp]", chunk.toString());
  });

  mcpProcess.on("exit", () => {
    mcpProcess = null;
  });

  await sendRequest("initialize", {
    workspaceRoot: workspace,
    extensionRoot: path.join(getRepoRoot(), "extension"),
  });
}

export async function callMcpTool(
  tool: string,
  args: Record<string, unknown>
): Promise<unknown> {
  await spawnMcpProcess();
  return sendRequest(`tools/${tool}`, args);
}

export function stopMcpProcess(): void {
  mcpProcess?.kill();
  mcpProcess = null;
}

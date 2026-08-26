import * as vscode from "vscode";
import * as cp from "child_process";
import * as path from "path";
import * as fs from "fs";
import { getMcpServerEntry, getRepoRoot } from "../paths";

export interface McpState {
  /**
   * Whether the MCP server is actually running.
   *
   * Every other field here defaults to false, so a server that never started
   * is indistinguishable from a Deck that is switched off -- which is exactly
   * how a packaging bug spent its life looking like a network problem. This
   * field is the difference between "off" and "we never found out".
   */
  mcpHealth: "starting" | "running" | "failed";
  mcpError?: string;
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
  mcpHealth: "starting",
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
let stderrTail = "";
let channel: vscode.OutputChannel | null = null;

function output(): vscode.OutputChannel {
  channel ??= vscode.window.createOutputChannel("Decky Plugin Studio");
  return channel;
}

export function showMcpOutput(): void {
  output().show(true);
}

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
      ...settingsEnv(),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  // A server that dies on startup used to be silent: the initialize promise
  // simply hung for its full 120s timeout and the caller swallowed the
  // rejection. Watch the exit directly so the failure has somewhere to go.
  mcpProcess.on("error", (err) => failed(`could not start the MCP server: ${err.message}`));

  mcpProcess.stdout?.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) handleLine(line);
  });

  mcpProcess.stderr?.on("data", (chunk: Buffer) => {
    const text = chunk.toString();
    stderrTail = (stderrTail + text).slice(-4000);
    output().appendLine(text.trimEnd());
  });

  mcpProcess.on("exit", (code) => {
    mcpProcess = null;
    // Fail every in-flight request now. Otherwise a server that dies during
    // startup leaves `initialize` hanging for its full 120s timeout, and the
    // extension looks merely slow rather than broken.
    for (const [id, pending] of pendingRequests) {
      pendingRequests.delete(id);
      pending.reject(new Error(`MCP server exited (code ${code}) before replying`));
    }
    if (state.mcpHealth !== "running" || code !== 0) {
      failed(
        `the MCP server exited (code ${code}).` +
          (stderrTail.trim() ? `\nLast output:\n${stderrTail.trim()}` : ""),
      );
    }
  });

  try {
    await sendRequest("initialize", {
      workspaceRoot: workspace,
      extensionRoot: path.join(getRepoRoot(), "extension"),
    });
    updateMcpState({ mcpHealth: "running", mcpError: undefined });
  } catch (err) {
    failed((err as Error).message);
    throw err;
  }
}

/**
 * The Deck settings, as environment variables the server understands.
 *
 * The manifest has contributed `deckyPluginStudio.deckIp` since 0.1.0 and
 * nothing ever read it. Blank values are dropped rather than passed through,
 * so an unset setting leaves whatever `deck_configure` wrote to deck.env alone.
 */
function settingsEnv(): Record<string, string> {
  const cfg = vscode.workspace.getConfiguration("deckyPluginStudio");
  const env: Record<string, string> = {};
  const ip = (cfg.get<string>("deckIp") ?? "").trim();
  const user = (cfg.get<string>("deckUser") ?? "").trim();
  const port = cfg.get<number>("ingestPort");
  if (ip) env.DECK_IP = ip;
  if (user) env.DECK_USER = user;
  if (port) env.DEBUG_INGEST_PORT = String(port);
  return env;
}

function failed(message: string): void {
  updateMcpState({ mcpHealth: "failed", mcpError: message });
  output().appendLine(`[decky-mcp] ${message}`);
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

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { PreviewManager } from "./manager";

const IPC_DIR = path.join(os.homedir(), ".decky-plugin-studio", "preview-ipc");
const SIDECAR_HTTP_PORT = Number(process.env.DECKY_HTTP_PORT ?? "8766");

type PreviewCommand =
  | { id: string; cmd: "injectFocus"; direction: string }
  | { id: string; cmd: "runSequence"; inputs: string[]; delayMs?: number }
  | { id: string; cmd: "callRpc"; method: string; args?: unknown[] }
  | { id: string; cmd: "snapshotDom"; selector?: string; args?: unknown[] }
  | { id: string; cmd: "captureScreenshot"; selector?: string }
  | { id: string; cmd: "callTestHook"; method: string; args?: unknown[] };

let watcher: fs.FSWatcher | undefined;
let pollInterval: ReturnType<typeof setInterval> | undefined;
let processing = false;

function listCommandFiles(): string[] {
  if (!fs.existsSync(IPC_DIR)) return [];
  return fs
    .readdirSync(IPC_DIR)
    .filter((name) => name.startsWith("cmd-") && name.endsWith(".json"))
    .map((name) => path.join(IPC_DIR, name));
}

async function sidecarRpc(method: string, args: unknown[] = []): Promise<unknown> {
  const res = await fetch(`http://127.0.0.1:${SIDECAR_HTTP_PORT}/rpc`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ method, args }),
    signal: AbortSignal.timeout(60_000),
  });
  const data = (await res.json()) as { result?: unknown; error?: string };
  if (data.error) throw new Error(data.error);
  return data.result;
}

async function processCommand(filePath: string, preview: PreviewManager): Promise<void> {
  let raw = "";
  try {
    raw = fs.readFileSync(filePath, "utf8");
    fs.unlinkSync(filePath);
  } catch {
    return;
  }

  let command: PreviewCommand;
  try {
    command = JSON.parse(raw) as PreviewCommand;
  } catch {
    return;
  }

  if (command.cmd === "injectFocus") {
    preview.injectFocus(command.direction);
    return;
  }

  if (command.cmd === "runSequence") {
    try {
      const result = await preview.runSequence(command.inputs, command.delayMs ?? 80);
      writeResult(command.id, { ok: true, result });
    } catch (err) {
      writeResult(command.id, { ok: false, error: String(err) });
    }
    return;
  }

  if (command.cmd === "callRpc") {
    try {
      const result = await sidecarRpc(command.method, command.args ?? []);
      writeResult(command.id, { ok: true, result });
    } catch (err) {
      writeResult(command.id, { ok: false, error: String(err) });
    }
    return;
  }

  if (command.cmd === "snapshotDom") {
    try {
      const result = await preview.snapshotDom({ selector: command.selector });
      writeResult(command.id, { ok: true, result });
    } catch (err) {
      writeResult(command.id, { ok: false, error: String(err) });
    }
    return;
  }

  if (command.cmd === "captureScreenshot") {
    try {
      const result = await preview.captureScreenshot({ selector: command.selector });
      writeResult(command.id, { ok: true, result });
    } catch (err) {
      writeResult(command.id, { ok: false, error: String(err) });
    }
    return;
  }

  if (command.cmd === "callTestHook") {
    try {
      const result = await preview.callTestHook(command.method, command.args ?? []);
      writeResult(command.id, { ok: true, result });
    } catch (err) {
      writeResult(command.id, { ok: false, error: String(err) });
    }
  }
}

function writeResult(id: string, payload: unknown): void {
  fs.mkdirSync(IPC_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(IPC_DIR, `result-${id}.json`),
    JSON.stringify(payload),
    "utf8"
  );
}

async function drainCommands(preview: PreviewManager): Promise<void> {
  if (processing) return;
  processing = true;
  try {
    for (const filePath of listCommandFiles()) {
      await processCommand(filePath, preview);
    }
  } finally {
    processing = false;
  }
}

export function startPreviewIpcBridge(preview: PreviewManager): void {
  stopPreviewIpcBridge();
  fs.mkdirSync(IPC_DIR, { recursive: true });
  void drainCommands(preview);
  try {
    watcher = fs.watch(IPC_DIR, () => {
      void drainCommands(preview);
    });
  } catch {
    /* polling fallback below */
  }
  const interval = setInterval(() => {
    if (!preview.isOpen()) {
      stopPreviewIpcBridge();
      return;
    }
    void drainCommands(preview);
  }, 250);
  pollInterval = interval;
}

export function stopPreviewIpcBridge(): void {
  watcher?.close();
  watcher = undefined;
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = undefined;
  }
}

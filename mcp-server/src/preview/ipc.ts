import fs from "fs";
import os from "os";
import path from "path";
import { randomUUID } from "crypto";

const IPC_DIR = path.join(os.homedir(), ".decky-plugin-studio", "preview-ipc");

export type PreviewIpcCommand = {
  id: string;
  cmd:
    | "injectFocus"
    | "runSequence"
    | "callRpc"
    | "snapshotDom"
    | "captureScreenshot"
    | "callTestHook";
  direction?: string;
  inputs?: string[];
  delayMs?: number;
  method?: string;
  args?: unknown[];
  selector?: string;
};

function ensureIpcDir(): void {
  fs.mkdirSync(IPC_DIR, { recursive: true });
}

export function getPreviewIpcDir(): string {
  return IPC_DIR;
}

export function sendPreviewCommand(
  command: Omit<PreviewIpcCommand, "id">
): string {
  ensureIpcDir();
  const id = randomUUID();
  const payload: PreviewIpcCommand = { ...command, id } as PreviewIpcCommand;
  fs.writeFileSync(path.join(IPC_DIR, `cmd-${id}.json`), JSON.stringify(payload), "utf8");
  return id;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitPreviewResult<T = unknown>(
  id: string,
  timeoutMs = 30_000
): Promise<T> {
  const resultPath = path.join(IPC_DIR, `result-${id}.json`);
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fs.existsSync(resultPath)) {
      const raw = fs.readFileSync(resultPath, "utf8");
      fs.unlinkSync(resultPath);
      return JSON.parse(raw) as T;
    }
    await sleep(50);
  }
  throw new Error(`Preview IPC timeout waiting for result-${id}.json`);
}

export function writePreviewResult(id: string, result: unknown): void {
  ensureIpcDir();
  fs.writeFileSync(
    path.join(IPC_DIR, `result-${id}.json`),
    JSON.stringify(result),
    "utf8"
  );
}

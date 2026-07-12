import fs from "fs";
import path from "path";
import os from "os";

export type EmitEvent = {
  t: number;
  event: string;
  args: unknown[];
};

const MAX_EMITS = 256;

function emitLogPath(sandboxRoot?: string): string {
  const root =
    sandboxRoot ??
    path.join(
      os.homedir(),
      ".decky-plugin-studio",
      "sandbox",
      path.basename(process.env.DECKY_STUDIO_WORKSPACE ?? process.cwd())
    );
  return path.join(root, "emit-log.jsonl");
}

export function appendEmitEvent(event: string, args: unknown[], sandboxRoot?: string): void {
  const file = emitLogPath(sandboxRoot);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const line = JSON.stringify({ t: Date.now(), event, args } satisfies EmitEvent);
  fs.appendFileSync(file, line + "\n", "utf8");

  try {
    const raw = fs.readFileSync(file, "utf8");
    const lines = raw.split("\n").filter(Boolean);
    if (lines.length > MAX_EMITS) {
      fs.writeFileSync(file, lines.slice(-MAX_EMITS).join("\n") + "\n", "utf8");
    }
  } catch {
    /* ignore trim errors */
  }
}

export function tailEmitEvents(params: {
  since?: number;
  lines?: number;
  event?: string;
  sandboxRoot?: string;
}): { events: EmitEvent[] } {
  const file = emitLogPath(params.sandboxRoot);
  if (!fs.existsSync(file)) return { events: [] };

  const max = Math.min(Math.max(1, params.lines ?? 50), MAX_EMITS);
  const since = params.since ?? 0;
  const filterEvent = params.event?.trim();

  const all = fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as EmitEvent)
    .filter((e) => e.t >= since)
    .filter((e) => !filterEvent || e.event === filterEvent);

  return { events: all.slice(-max) };
}

export function clearEmitLog(sandboxRoot?: string): void {
  const file = emitLogPath(sandboxRoot);
  if (fs.existsSync(file)) fs.writeFileSync(file, "", "utf8");
}

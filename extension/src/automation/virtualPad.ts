import * as fs from "fs";
import * as net from "net";
import * as os from "os";
import * as path from "path";

/**
 * The virtual controllers on THIS PC, read and reached without the Studio server.
 *
 * Plan 10 gives a stand-in Deck a software gamepad (bridge/tools/vpad.py) in
 * place of the ESP32 board. On this Windows PC that pad is a ViGEmBus
 * controller Steam sees as an Xbox pad, which means a wedged run can leave it
 * holding a button on the user's own Steam. The killswitch has to cover it
 * with the same guarantee the board gets -- and, like latch.ts, that guarantee
 * cannot depend on a server that may be the very thing that is wedged.
 *
 * So this module duplicates two small things from the server on purpose: the
 * registry path (machines.json, same reasoning as latch.ts duplicating the
 * latch path) and the daemon's one-line JSON protocol (`{"t":"release"}`,
 * `{"t":"status"}`). Only LOCAL pads are reachable from here; a pad inside a
 * VM is behind SSH and belongs to the server's stop, and it releases itself
 * on disconnect and after 750 ms of silence regardless.
 */
const CONFIG_DIR = (): string => path.join(os.homedir(), ".config", "decky-plugin-studio");
const MACHINES_PATH = (): string => path.join(CONFIG_DIR(), "machines.json");
const DEFAULT_PAD_PORT = 7690;

export interface LocalPad {
  machine: string;
  transport: "uinput" | "vigem";
  host: string;
  port: number;
}

export interface PadState extends LocalPad {
  reachable: boolean;
  held: string[];
  backend?: string;
  reason?: string;
}

/** Machines in the registry that are local to this PC and press through a virtual pad. */
export function listLocalPads(): LocalPad[] {
  let parsed: { machines?: Record<string, Record<string, unknown>> };
  try {
    if (!fs.existsSync(MACHINES_PATH())) return [];
    parsed = JSON.parse(fs.readFileSync(MACHINES_PATH(), "utf8"));
  } catch {
    return [];
  }
  const out: LocalPad[] = [];
  for (const [name, entry] of Object.entries(parsed.machines ?? {})) {
    if (!entry || typeof entry !== "object") continue;
    const press = entry.press;
    if (!entry.local || (press !== "uinput" && press !== "vigem")) continue;
    const port = Number(entry.padPort ?? DEFAULT_PAD_PORT);
    out.push({ machine: name, transport: press, host: "127.0.0.1", port: Number.isFinite(port) ? port : DEFAULT_PAD_PORT });
  }
  return out;
}

function exchange(pad: LocalPad, cmd: Record<string, unknown>, timeoutMs: number): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    let done = false;
    let buf = "";
    const sock = net.connect({ host: pad.host, port: pad.port });
    const finish = (v: Record<string, unknown> | null): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      sock.destroy();
      resolve(v);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    sock.setEncoding("utf8");
    sock.on("error", () => finish(null));
    sock.on("close", () => finish(null));
    sock.on("connect", () => sock.write(JSON.stringify(cmd) + "\n"));
    sock.on("data", (d: string) => {
      buf += d;
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        try {
          const obj = JSON.parse(line) as Record<string, unknown>;
          if ("ok" in obj) {
            finish(obj);
            return;
          }
        } catch {
          /* an event line, or noise; keep reading */
        }
      }
    });
  });
}

/** Ask one pad to report in. `status` writes nothing to the device. */
export async function probePad(pad: LocalPad, timeoutMs = 1500): Promise<PadState> {
  const ack = await exchange(pad, { t: "status" }, timeoutMs);
  if (!ack || ack.ok !== true) {
    return { ...pad, reachable: false, held: [], reason: ack ? String(ack.err ?? "refused") : "no answer" };
  }
  return {
    ...pad,
    reachable: true,
    held: Array.isArray(ack.held) ? (ack.held as string[]) : [],
    backend: ack.backend != null ? String(ack.backend) : undefined,
  };
}

export async function probeLocalPads(): Promise<PadState[]> {
  return Promise.all(listLocalPads().map((p) => probePad(p)));
}

export interface PadReleaseOutcome {
  machine: string;
  attempted: boolean;
  ok: boolean;
  detail: string;
}

/**
 * Tell every local virtual pad to go neutral, directly from the extension
 * host. Run right after the latch is written and before the server is asked
 * for anything, for the same reason the latch is: the server may be busy in
 * the middle of the very run being stopped.
 */
export async function releaseLocalPads(timeoutMs = 2000): Promise<PadReleaseOutcome[]> {
  const pads = listLocalPads();
  return Promise.all(
    pads.map(async (pad) => {
      const ack = await exchange(pad, { t: "release" }, timeoutMs);
      if (ack && ack.ok === true) {
        return { machine: pad.machine, attempted: true, ok: true, detail: `virtual pad on ${pad.machine} released` };
      }
      return {
        machine: pad.machine,
        attempted: true,
        ok: false,
        detail: `virtual pad on ${pad.machine} did not acknowledge (${ack ? String(ack.err ?? "refused") : "no answer on " + pad.host + ":" + pad.port}); it neutralises itself 750 ms after the link falls silent`,
      };
    }),
  );
}

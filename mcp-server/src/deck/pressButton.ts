/**
 * deck.pressButton -- deliver a press Steam actually routes.
 *
 * The press comes from the ESP32-S3 bridge board (see bridge/README.md), which
 * enumerates on the Deck as a real USB HID gamepad -- confirmed on device as
 * `js0: Espressif Systems ESP32S3_DEV`. Steam sees a controller and routes it
 * through Steam Input into the same nav path a physical pad uses. That is the
 * `steam-routed` fidelity plan 01 § A.2 asks for.
 *
 * This supersedes the uinput virtual pad A.2 specified. The spike A.3 was meant
 * to answer -- "will gamescope accept a fresh virtual device, or does it need a
 * manual enable?" -- no longer gates anything, because the bridge is a device
 * Steam demonstrably accepts.
 *
 * Decision E2, unchanged: when the bridge is unavailable this REFUSES. It does
 * not fall back to a DOM-synthetic press or an element.focus() call. Those
 * prove a handler ran and nothing more, and they are the mechanism behind the
 * three no-op fixes this whole effort exists to stop. A tool that sometimes
 * says "I cannot verify this right now" is worth more than one that is
 * occasionally, silently wrong.
 */
import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

/** Names the firmware accepts. Anything else is refused rather than guessed at. */
export const BRIDGE_BUTTONS = [
  "UP",
  "DOWN",
  "LEFT",
  "RIGHT",
  "A",
  "B",
  "X",
  "Y",
  "LB",
  "RB",
  "SELECT",
  "START",
  "GUIDE",
  "L3",
  "R3",
] as const;

export interface PressResult {
  ok: boolean;
  reason?: string;
  /** Only ever "steam-routed" -- there is no weaker tier, by design. */
  fidelity: "steam-routed" | null;
  method: string;
  buttons: string[];
  holdMs: number;
  /** Raw firmware acknowledgement, for post-mortems. */
  ack?: string;
}

export interface PressOptions {
  buttons: string[];
  holdMs?: number;
  /** Serial port of the bridge's COM side. Defaults to the tool's own default. */
  port?: string;
  timeoutMs?: number;
}

/**
 * Find bridge/tools/pad.py by walking up from this module. The MCP server runs
 * from dist/ in the repo and from resources/ inside the VSIX, so a fixed
 * relative path would be right in exactly one of those.
 */
export function findPadTool(): string | null {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    const candidate = path.join(dir, "bridge", "tools", "pad.py");
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

const REFUSAL =
  "The controller bridge is not available, so no press can be delivered that Steam would " +
  "route. Refusing rather than falling back to a synthetic press, which would prove a " +
  "handler ran and nothing more. Check that the board is plugged into this PC (its COM " +
  "side) and into the Deck (its USB side), and that python with pyserial is on PATH.";

export async function pressButton(opts: PressOptions): Promise<PressResult> {
  const holdMs = opts.holdMs ?? 80;
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const buttons = opts.buttons.map((b) => b.trim().toUpperCase());

  const base: PressResult = {
    ok: false,
    fidelity: null,
    method: "usb-hid:bridge",
    buttons,
    holdMs,
  };

  if (buttons.length === 0) {
    return { ...base, reason: "No buttons given." };
  }
  const unknown = buttons.filter((b) => !(BRIDGE_BUTTONS as readonly string[]).includes(b));
  if (unknown.length > 0) {
    return {
      ...base,
      reason: `Unknown button(s): ${unknown.join(", ")}. Known: ${BRIDGE_BUTTONS.join(", ")}.`,
    };
  }

  const pad = findPadTool();
  if (!pad) {
    return { ...base, reason: `${REFUSAL} (bridge/tools/pad.py not found from ${import.meta.url})` };
  }

  const args = [pad, "press", ...buttons, "--ms", String(holdMs)];
  if (opts.port) args.push("--port", opts.port);

  return new Promise<PressResult>((resolve) => {
    const child = spawn("python", args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    let done = false;

    const finish = (r: PressResult): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(r);
    };

    const timer = setTimeout(() => {
      child.kill();
      finish({ ...base, reason: `${REFUSAL} (pad.py did not answer within ${timeoutMs}ms)` });
    }, timeoutMs);

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (d: string) => (out += d));
    child.stderr?.on("data", (d: string) => (err += d));

    child.on("error", (e) => finish({ ...base, reason: `${REFUSAL} (${e.message})` }));

    child.on("close", (code) => {
      // The firmware acknowledges each command as one JSON line prefixed "<- ".
      const ack = out
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.startsWith("<- "))
        .map((l) => l.slice(3))
        .find((l) => l.includes('"t":"press"'));

      if (code !== 0 || !ack) {
        const detail = (err.trim() || out.trim() || "no output").slice(0, 300);
        return finish({ ...base, reason: `${REFUSAL} (pad.py exit ${code}: ${detail})` });
      }
      try {
        if (JSON.parse(ack).ok !== true) {
          return finish({ ...base, reason: `${REFUSAL} (firmware refused: ${ack})` });
        }
      } catch {
        return finish({ ...base, reason: `${REFUSAL} (unparseable acknowledgement: ${ack})` });
      }
      finish({ ...base, ok: true, fidelity: "steam-routed", ack });
    });
  });
}

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
 *
 * TWO FIDELITY TIERS, found 2026-08-27 the hard way. With the bridge board
 * plugged into this PC but its OTHER USB lead unplugged from the Deck, the
 * firmware still opens its serial port and still acknowledges every `press`
 * command -- it has no way to know whether its HID side ever reached
 * anything. Every press used to report `fidelity: "steam-routed"` off that
 * acknowledgement alone, which is exactly the false "success" this rig exists
 * to catch, just one layer further down than deck_status's bridgeReady.
 *
 * So a plain press now reports `"wire-sent"`: true, and the only thing an ack
 * proves -- the command went down the wire to the board and it answered.
 * `"steam-routed"` is no longer reachable that way. It is EARNED only by
 * `verify: true`, which reads Steam's gamepad focus before and after the
 * press over CDP and reports `"steam-routed"` solely when that focus actually
 * changed -- proof the Deck, not just the board, received something. Costs a
 * CDP round trip on top of the press, so it is opt-in.
 */
import { spawn } from "child_process";

import { findBridgeTool, findPadTool } from "./bridgeTools.js";
import { automationStopped, stoppedMessage } from "./killswitch.js";
import { openCdpTunnel } from "./cdpTunnel.js";
import { readFocusAt } from "./readFocus.js";
import { focusKey } from "./focusKey.js";

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
  /**
   * "wire-sent" -- the bridge firmware acknowledged the command; nothing more
   * is known, in particular NOT whether the Deck received anything.
   * "steam-routed" -- earned only when `verify: true` was requested and a
   * before/after focus read over CDP confirmed Steam's gamepad focus actually
   * changed. null when no press was sent at all (validation error, refusal).
   */
  fidelity: "wire-sent" | "steam-routed" | null;
  method: string;
  buttons: string[];
  holdMs: number;
  /** Raw firmware acknowledgement, for post-mortems. */
  ack?: string;
  /**
   * True when the first attempt could not OPEN the serial port and a second
   * attempt, ~350 ms later, delivered the press. See portBusy(). Reported so
   * a run log can show the collision rather than hide it.
   */
  retried?: boolean;
  /** Present only when `verify` was requested: whether a focus check actually ran. */
  verified?: boolean;
}

/**
 * The one failure a press is allowed to retry: the COM port could not be
 * opened because something else had it. Measured 2026-08-31 during the first
 * deck_sweep runs: a press failed with `SerialException: could not open port
 * 'COM7': PermissionError(13, 'Access is denied.')` every ~30 s -- which is the
 * cadence of the extension's deck_status poll, whose probeBridge runs
 * `pad.py status` and opens the same port. Two openers, one port.
 *
 * Retrying THIS is not retrying a press that did not land -- nothing was
 * sent, the host lost a race for a serial handle -- so it does not fall under
 * "no retries" (runSequence's header): re-pressing until focus moves is how a
 * flaky focus graph gets marked green, and this never re-presses. Every other
 * failure stays a refusal.
 */
export function portBusy(detail: string): boolean {
  return /could not open port/i.test(detail) && /PermissionError|Access is denied|busy/i.test(detail);
}

/**
 * The line of a failed pad.py run worth showing. The exception is the LAST
 * line of a Python traceback; the old head-of-stderr slice cut it off, and the
 * 2026-08-31 collision above was diagnosed from a report that ended in
 * `File "C:\Users\sti` -- which says nothing.
 */
export function failureDetail(err: string, out: string): string {
  const lines = err
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length) return lines[lines.length - 1].slice(0, 300);
  return (out.trim() || "no output").slice(0, 300);
}

export interface PressOptions {
  buttons: string[];
  holdMs?: number;
  /** Serial port of the bridge's COM side. Defaults to the tool's own default. */
  port?: string;
  timeoutMs?: number;
  /**
   * Opt-in. Earns `fidelity: "steam-routed"` by reading Steam's gamepad focus
   * over CDP before the press and again after it, and reporting the stronger
   * fidelity only when that focus actually changed. Costs a CDP round trip on
   * top of the press itself, so it defaults off -- with it off, the result
   * never claims more than "wire-sent" (see PressResult.fidelity).
   */
  verify?: boolean;
  /** CDP endpoint for `verify`. Default opens its own SSH forward and closes it when done. */
  cdpUrl?: string;
  /** Upper bound, in ms, on waiting for focus to settle after a verified press. Default 1500. */
  verifySettleMs?: number;
  /**
   * TEST SEAM, same idea as openPlugin's `pressFn` and deckAutonomy's
   * `findPad`/`run`: `child_process`'s exports are non-configurable, so a
   * test cannot mock `spawn` directly. Production never sets this; tests
   * inject a fake so `verify`'s before/press/after orchestration can be
   * pinned without a board. Defaults to the real bridge-spawning delivery.
   */
  sendRaw?: (opts: PressOptions) => Promise<PressResult>;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Re-exported so every existing importer keeps working. The implementation
 * moved to bridgeTools.js when the killswitch needed to find pad.py without
 * importing the module whose presses it exists to stop.
 */
export { findBridgeTool, findPadTool };

const REFUSAL =
  "The controller bridge is not available, so no press can be delivered that Steam would " +
  "route. Refusing rather than falling back to a synthetic press, which would prove a " +
  "handler ran and nothing more. Check that the board is plugged into this PC (its COM " +
  "side) and into the Deck (its USB side), and that python with pyserial is on PATH.";

/**
 * The one gate every press passes through. Two ways to be forbidden.
 *
 * DPS_NO_BRIDGE -- a hard stop for automated suites. Every press here reaches a
 * real controller wired to a real Deck. The board is plugged into the machine
 * that runs the tests, so a test that happens to walk into this function does
 * not fail politely: it moves the ring on someone's device, and with the wrong
 * control focused it can activate something. That is not a hypothetical --
 * adding a default-on focus-acquire to walkTo made its unit test send a live
 * DOWN press before anyone noticed. The npm test script sets DPS_NO_BRIDGE=1 so
 * the suite refuses at this line instead of spawning anything, and anyone can
 * set it by hand to be certain a run cannot touch hardware.
 *
 * THE KILLSWITCH LATCH -- a human said stop. Checked here, on the last line
 * before a press is spawned, rather than only at the top of whatever loop is
 * running: that is what makes the guarantee "no press goes out after the latch
 * is set" true regardless of where any process happened to be. The loops check
 * it too, but only so they can abort promptly and report honestly; this check
 * is the one that is load-bearing.
 *
 * The env var is checked first because it is the cheaper of the two and because
 * a suite run should say it is a suite run, not blame the killswitch.
 */
export function bridgeDisabled(): string | null {
  const v = process.env.DPS_NO_BRIDGE;
  if (v && v !== "0" && v.toLowerCase() !== "false") {
    return (
      "The controller bridge is disabled by DPS_NO_BRIDGE, so no press was sent. " +
      "This guard exists so an automated suite cannot move the ring on a real Deck. " +
      "Unset it to drive hardware."
    );
  }
  const stopped = automationStopped();
  if (stopped) return stoppedMessage(stopped);
  return null;
}

/**
 * The real bridge-spawning delivery: validate, refuse if disabled, spawn
 * pad.py, retry once on a port collision. This is what `pressButton` calls by
 * default, and what `verify` calls to actually put the press on the wire --
 * the two paths must share one implementation so a fix here is not a fix in
 * only one of them.
 *
 * Success here is `fidelity: "wire-sent"`, never `"steam-routed"`: an ack from
 * the firmware proves the command reached the board, nothing about whether
 * the board's other USB lead reaches the Deck. See the module doc comment.
 */
async function deliverPress(opts: PressOptions): Promise<PressResult> {
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

  // After validation, before anything is spawned. An unknown button is a caller
  // error whether or not a board is attached; only the spawn touches hardware.
  const disabled = bridgeDisabled();
  if (disabled) return { ...base, reason: disabled };

  const pad = findPadTool();
  if (!pad) {
    return { ...base, reason: `${REFUSAL} (bridge/tools/pad.py not found from ${import.meta.url})` };
  }

  const args = [pad, "press", ...buttons, "--ms", String(holdMs)];
  if (opts.port) args.push("--port", opts.port);

  const attempt = (): Promise<PressResult & { detail?: string }> =>
    new Promise((resolve) => {
      const child = spawn("python", args, { stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      let err = "";
      let done = false;

      const finish = (r: PressResult & { detail?: string }): void => {
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
          const detail = failureDetail(err, out);
          return finish({ ...base, reason: `${REFUSAL} (pad.py exit ${code}: ${detail})`, detail });
        }
        try {
          if (JSON.parse(ack).ok !== true) {
            return finish({ ...base, reason: `${REFUSAL} (firmware refused: ${ack})` });
          }
        } catch {
          return finish({ ...base, reason: `${REFUSAL} (unparseable acknowledgement: ${ack})` });
        }
        finish({ ...base, ok: true, fidelity: "wire-sent", ack });
      });
    });

  const first = await attempt();
  if (first.ok || !first.detail || !portBusy(first.detail)) {
    const { detail: _detail, ...result } = first;
    return result;
  }

  // The port was held by another opener (see portBusy). Nothing was sent, so
  // one more try is not a second press. The latch is re-checked: a human may
  // have stopped the rig in the meantime, and no press goes out after that.
  await new Promise((r) => setTimeout(r, 350));
  const stoppedMeanwhile = bridgeDisabled();
  if (stoppedMeanwhile) return { ...base, reason: stoppedMeanwhile };
  const second = await attempt();
  const { detail: _detail2, ...result } = second;
  return second.ok
    ? { ...result, retried: true }
    : { ...result, reason: `${result.reason} -- and again after a 350ms retry (first: ${first.detail})` };
}

/**
 * deliver a press, and -- when `verify` is set -- earn `"steam-routed"` by
 * reading Steam's gamepad focus over CDP before the press and again after it.
 *
 * Without `verify` this is exactly `deliverPress`: `"wire-sent"` on success,
 * nothing claimed about the Deck. With it, `"steam-routed"` is reported ONLY
 * when the before/after focus actually differs -- the one fact an ack from
 * the board's serial side cannot supply, and the whole reason the 2026-08-27
 * incident (board plugged into the PC, unplugged from the Deck) went
 * unnoticed at every layer, this one included.
 */
export async function pressButton(opts: PressOptions): Promise<PressResult> {
  const send = opts.sendRaw ?? deliverPress;
  if (!opts.verify) return send(opts);

  const holdMs = opts.holdMs ?? 80;
  const buttons = opts.buttons.map((b) => b.trim().toUpperCase());
  const base: PressResult = {
    ok: false,
    fidelity: null,
    method: "usb-hid:bridge",
    buttons,
    holdMs,
    verified: false,
  };

  // Validate and check the gates BEFORE opening a CDP tunnel: a bad button
  // name or a stopped rig must refuse here exactly as an unverified press
  // does, not after paying for an SSH forward that was always going nowhere.
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
  const disabled = bridgeDisabled();
  if (disabled) return { ...base, reason: disabled };

  let cdpBase = opts.cdpUrl;
  let closeTunnel: (() => void) | null = null;
  if (!cdpBase) {
    try {
      const tunnel = await openCdpTunnel();
      cdpBase = tunnel.base;
      closeTunnel = tunnel.close;
    } catch (err) {
      return {
        ...base,
        reason:
          `verify was requested but the Deck's CDP endpoint could not be reached, so nothing ` +
          `could be confirmed: ${(err as Error).message}`,
      };
    }
  }

  try {
    const before = await readFocusAt(cdpBase, 10_000);
    if (!before.ok) {
      return {
        ...base,
        reason:
          `verify was requested but focus could not be read before the press, so nothing could ` +
          `be confirmed: ${before.reason}`,
      };
    }

    const pressed = await send(opts);
    if (!pressed.ok) return { ...pressed, verified: false };

    const beforeKey = focusKey(before);
    const settleMs = Math.max(0, opts.verifySettleMs ?? 1500);
    const started = Date.now();
    let after = before;
    for (;;) {
      await sleep(120);
      after = await readFocusAt(cdpBase, 10_000);
      if (focusKey(after) !== beforeKey) break;
      if (Date.now() - started > settleMs) break;
    }

    if (focusKey(after) !== beforeKey) {
      return { ...pressed, fidelity: "steam-routed", verified: true };
    }

    // The press went out and the board acknowledged it (pressed.ok is true),
    // but Steam's own focus never moved. This is the exact dead-board shape:
    // do not claim steam-routed, and do not claim ok either -- verify was
    // asked to confirm delivery and it could not.
    return {
      ...pressed,
      ok: false,
      fidelity: "wire-sent",
      verified: true,
      reason:
        "The press was sent down the wire and the bridge acknowledged it, but Steam's gamepad " +
        "focus did not change, so this cannot confirm the Deck actually received it. Check that " +
        "the board's USB lead is plugged into the Deck, not just this PC.",
    };
  } finally {
    closeTunnel?.();
  }
}

/**
 * Hold one button, tap another, release -- a real chord rather than two buttons
 * pressed at the same instant.
 *
 * These are NOT interchangeable, which cost an hour on 2026-08-26. Steam's
 * Quick Access Menu opens on hold-GUIDE-then-tap-A. Sending GUIDE and A
 * together in one 80 ms press is read as a bare GUIDE press: the Steam main
 * menu opens instead, and the A lands in whatever that menu is showing. When
 * the ring happened to be on a game's Play button, the same mistake was one
 * press away from launching a game.
 *
 * Delegates to bridge/tools/chord.py, which owns the four-step sequence.
 */
export async function pressChord(
  hold: string,
  tap: string,
  opts: { port?: string; timeoutMs?: number } = {},
): Promise<PressResult> {
  const H = hold.trim().toUpperCase();
  const T = tap.trim().toUpperCase();
  const base: PressResult = {
    ok: false,
    fidelity: null,
    method: "usb-hid:bridge:chord",
    buttons: [H, T],
    holdMs: 0,
  };

  const unknown = [H, T].filter((b) => !(BRIDGE_BUTTONS as readonly string[]).includes(b));
  if (unknown.length > 0) {
    return { ...base, reason: `Unknown button(s): ${unknown.join(", ")}. Known: ${BRIDGE_BUTTONS.join(", ")}.` };
  }

  const chordDisabled = bridgeDisabled();
  if (chordDisabled) return { ...base, reason: chordDisabled };

  const tool = findBridgeTool("chord.py");
  if (!tool) {
    return { ...base, reason: `${REFUSAL} (bridge/tools/chord.py not found from ${import.meta.url})` };
  }

  const args = [tool, H, T];
  if (opts.port) args.push("--port", opts.port);
  const timeoutMs = opts.timeoutMs ?? 20_000;

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
      finish({ ...base, reason: `${REFUSAL} (chord.py did not answer within ${timeoutMs}ms)` });
    }, timeoutMs);

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (d: string) => (out += d));
    child.stderr?.on("data", (d: string) => (err += d));
    child.on("error", (e) => finish({ ...base, reason: `${REFUSAL} (${e.message})` }));
    child.on("close", (code) => {
      // chord.py prints one JSON acknowledgement per step and ends with "chord sent".
      const refused = /"ok"\s*:\s*false/.test(out);
      if (code !== 0 || refused || !/chord sent/.test(out)) {
        const detail = (err.trim() || out.trim() || "no output").slice(0, 300);
        return finish({ ...base, reason: `${REFUSAL} (chord.py exit ${code}: ${detail})` });
      }
      // Same honesty fix as deliverPress, same reason: an ack from the board
      // proves the chord went down the wire, nothing about the Deck's side.
      // No `verify` support here (out of scope) -- just no longer a lie.
      finish({ ...base, ok: true, fidelity: "wire-sent", ack: "chord sent" });
    });
  });
}

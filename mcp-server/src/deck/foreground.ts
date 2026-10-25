/**
 * Is Steam Big Picture the window in front?
 *
 * On a Windows stand-in Steam only takes pad input while Big Picture is the
 * foreground window. Nothing else in DPS knew that: with another window in
 * front, readFocus said "nothing owns gamepad focus" and the helper that
 * places the ring answered with a blind D-pad press, which went into whatever
 * window was in front (GitHub issue #5).
 *
 * The signal is in reach: the `Steam Big Picture Mode` CDP page reports
 * `document.visibilityState === "hidden"` and `document.hasFocus() === false`
 * when it is behind. This reads both. It presses nothing.
 *
 * "unknown" is a real answer and never a pass: a missing page, or one that
 * does not answer, leaves the caller with no evidence either way.
 */
import { evaluate, listTargets, rewriteWsHost } from "./cdp.js";
import { openCdpTunnel } from "./cdpTunnel.js";
import { execFileSync } from "child_process";

export const BIG_PICTURE_TITLE = "Steam Big Picture Mode";

export interface ForegroundResult {
  /** true: in front. false: behind another window. "unknown": could not tell. */
  foreground: boolean | "unknown";
  visibilityState: string | null;
  hasFocus: boolean | null;
  /** One plain sentence saying what was seen. */
  reason: string;
}

export interface ForegroundOptions {
  /** Budget for the target list and for the one evaluate, in ms (default 4000). */
  timeoutMs?: number;
}

const EXPRESSION = "({ visibilityState: document.visibilityState, hasFocus: document.hasFocus() })";

/** The sentence a refusal or a failed check uses when Big Picture is behind. */
export function notForegroundSentence(r: Pick<ForegroundResult, "visibilityState" | "hasFocus">): string {
  return `Big Picture is not the foreground window (visibilityState ${r.visibilityState}, hasFocus ${r.hasFocus})`;
}

function unknownResult(reason: string): ForegroundResult {
  return { foreground: "unknown", visibilityState: null, hasFocus: null, reason };
}

/**
 * What deck_status reports on a Windows machine: opens its own short-lived CDP
 * tunnel (a no-op dial on a local machine), reads, closes. Never throws.
 */
export async function bigPictureStatus(
  open: () => Promise<{ base: string; close: () => void }> = openCdpTunnel,
): Promise<Pick<ForegroundResult, "foreground" | "visibilityState" | "hasFocus"> & { reason?: string }> {
  let tunnel: { base: string; close: () => void } | null = null;
  try {
    tunnel = await open();
    const r = await readBigPictureForeground(tunnel.base);
    return {
      foreground: r.foreground,
      visibilityState: r.visibilityState,
      hasFocus: r.hasFocus,
      ...(r.foreground === "unknown" ? { reason: r.reason } : {}),
    };
  } catch (err) {
    return {
      foreground: "unknown",
      visibilityState: null,
      hasFocus: null,
      reason: `could not reach Steam's debugger: ${(err as Error).message}`,
    };
  } finally {
    tunnel?.close();
  }
}

export async function readBigPictureForeground(
  cdpBase: string,
  opts: ForegroundOptions = {},
): Promise<ForegroundResult> {
  const timeoutMs = opts.timeoutMs ?? 4000;
  let wsUrl: string | undefined;
  try {
    const targets = await listTargets(cdpBase, timeoutMs);
    wsUrl = targets.find((t) => t.title === BIG_PICTURE_TITLE && t.webSocketDebuggerUrl)?.webSocketDebuggerUrl;
  } catch (err) {
    return unknownResult(`could not list Steam's pages to find "${BIG_PICTURE_TITLE}": ${(err as Error).message}`);
  }
  if (!wsUrl) {
    return unknownResult(
      `no "${BIG_PICTURE_TITLE}" page is listed, so whether Big Picture is in front cannot be read`,
    );
  }
  let v: { visibilityState?: unknown; hasFocus?: unknown } | undefined;
  try {
    v = await evaluate<{ visibilityState?: unknown; hasFocus?: unknown }>(
      rewriteWsHost(wsUrl, cdpBase),
      EXPRESSION,
      timeoutMs,
    );
  } catch (err) {
    return unknownResult(`"${BIG_PICTURE_TITLE}" did not answer: ${(err as Error).message}`);
  }
  if (!v || typeof v.visibilityState !== "string" || typeof v.hasFocus !== "boolean") {
    return unknownResult(`"${BIG_PICTURE_TITLE}" answered with something that is not a visibility reading`);
  }
  const { visibilityState, hasFocus } = v;
  const foreground = visibilityState === "visible" && hasFocus;
  return {
    foreground,
    visibilityState,
    hasFocus,
    reason: foreground
      ? `Big Picture is the foreground window (visibilityState ${visibilityState}, hasFocus ${hasFocus})`
      : notForegroundSentence({ visibilityState, hasFocus }),
  };
}

// ---------------------------------------------------------------------------
// deck_focusBigPicture: put Big Picture back in front without a hand.
//
// Measured on the maintainer's PC, 2026-10-25, with the gate above as the
// oracle. Three states, two recipes:
//   - behind another window (visible, hasFocus false): Steam's own
//     SteamClient.Window.BringToFront(1) followed by SetKeyFocus(false) then
//     SetKeyFocus(true) brings it forward and gives it focus. SetKeyFocus(true)
//     alone does nothing when Steam already believes it has focus, which is
//     why the toggle. BringToFront needs the int, not a bool.
//   - minimized (hidden, hasFocus false, IsWindowMinimized true): no Steam
//     call restores it (ShowWindow, BringToFront, RestoreWindowSizeAndPosition
//     were all tried). One Win32 ShowWindow(SW_RESTORE) does, and a background
//     process may call it. Then the recipe above for focus.
//   - already in front: nothing is done, and the result says so.
// Nothing here presses a button. A window-manager that refuses is reported,
// never worked around: the result's `after` is the gate read again, so a
// caller never has to take this tool's word for it.
// ---------------------------------------------------------------------------


export interface FocusBigPictureResult {
  /** true only when the gate reads foreground after the attempt. */
  ok: boolean;
  before: ForegroundResult;
  after: ForegroundResult | null;
  /** Whether Steam said its window was minimized before anything was done. */
  wasMinimized: boolean | "unknown";
  /** What was done, in order. Empty when Big Picture was already in front. */
  steps: string[];
  /** One plain paragraph. */
  reason: string;
}

export interface FocusBigPictureOptions {
  /** Per-call CDP budget in ms (default 4000). */
  timeoutMs?: number;
  /** How long to give Windows to settle before the second gate read (default 700). */
  settleMs?: number;
  /**
   * Un-minimize the window. Default: the packaged restore-window.ps1 through
   * PowerShell. Tests pass a stub; a throw is reported, not retried.
   */
  restoreWindow?: () => void;
}

const MINIMIZED_EXPRESSION = "SteamClient.Window.IsWindowMinimized()";
const BRING_TO_FRONT_EXPRESSION =
  "(SteamClient.Window.BringToFront(1), SteamClient.Window.SetKeyFocus(false), SteamClient.Window.SetKeyFocus(true), 'ok')";

export function defaultRestoreWindow(scriptPath: string): () => void {
  return () => {
    execFileSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptPath], {
      stdio: "pipe",
      timeout: 15_000,
    });
  };
}

/**
 * Bring Big Picture to the front on a Windows stand-in. `cdpBase` is Steam's
 * local debugger (a stand-in is local, so no tunnel). Never throws: every
 * failure is an `ok: false` with the gate's own reading in `after`.
 */
export async function focusBigPicture(
  cdpBase: string,
  opts: FocusBigPictureOptions,
): Promise<FocusBigPictureResult> {
  const timeoutMs = opts.timeoutMs ?? 4000;
  const settleMs = opts.settleMs ?? 700;
  const steps: string[] = [];

  const before = await readBigPictureForeground(cdpBase, { timeoutMs });
  if (before.foreground === true) {
    return {
      ok: true,
      before,
      after: before,
      wasMinimized: false,
      steps,
      reason: "Big Picture was already the foreground window; nothing was done.",
    };
  }
  if (before.foreground === "unknown") {
    return {
      ok: false,
      before,
      after: null,
      wasMinimized: "unknown",
      steps,
      reason: `could not read whether Big Picture is in front, so nothing was done: ${before.reason}`,
    };
  }

  // The gate read found the page, so the websocket url is there to find again.
  let wsUrl: string;
  try {
    const targets = await listTargets(cdpBase, timeoutMs);
    const url = targets.find((t) => t.title === BIG_PICTURE_TITLE && t.webSocketDebuggerUrl)?.webSocketDebuggerUrl;
    if (!url) throw new Error(`no "${BIG_PICTURE_TITLE}" page is listed any more`);
    wsUrl = rewriteWsHost(url, cdpBase);
  } catch (err) {
    return {
      ok: false,
      before,
      after: null,
      wasMinimized: "unknown",
      steps,
      reason: `Big Picture is behind, and its page could not be reached to fix that: ${(err as Error).message}`,
    };
  }

  let wasMinimized: boolean | "unknown" = "unknown";
  try {
    const v = await evaluate<unknown>(wsUrl, MINIMIZED_EXPRESSION, timeoutMs);
    wasMinimized = typeof v === "boolean" ? v : "unknown";
  } catch (err) {
    steps.push(`could not ask Steam whether its window is minimized (${(err as Error).message}); went on as if it is not`);
  }

  if (wasMinimized === true) {
    const restore = opts.restoreWindow;
    if (!restore) {
      return {
        ok: false,
        before,
        after: null,
        wasMinimized,
        steps,
        reason:
          "Big Picture is minimized, and Steam cannot restore its own window; the Win32 restore script was not available, so nothing was done.",
      };
    }
    try {
      restore();
      steps.push("restored the minimized window with one Win32 ShowWindow(SW_RESTORE), because Steam's own calls cannot");
    } catch (err) {
      const after = await readBigPictureForeground(cdpBase, { timeoutMs });
      return {
        ok: after.foreground === true,
        before,
        after,
        wasMinimized,
        steps,
        reason: `Big Picture is minimized and the Win32 restore failed: ${(err as Error).message}. Afterwards: ${after.reason}.`,
      };
    }
  }

  try {
    await evaluate<unknown>(wsUrl, BRING_TO_FRONT_EXPRESSION, timeoutMs);
    steps.push("asked Steam to bring Big Picture to the front and take key focus (BringToFront(1), SetKeyFocus off then on)");
  } catch (err) {
    steps.push(`Steam's bring-to-front call failed: ${(err as Error).message}`);
  }

  if (settleMs > 0) await new Promise((r) => setTimeout(r, settleMs));
  const after = await readBigPictureForeground(cdpBase, { timeoutMs });
  const ok = after.foreground === true;
  return {
    ok,
    before,
    after,
    wasMinimized,
    steps,
    reason: ok
      ? `Big Picture is the foreground window now (was: ${before.reason}).`
      : `Big Picture is still not in front after the attempt: ${after.reason}. ` +
        "Bring it forward by hand (click it, or alt-tab to it); if that also fails, Steam may have a modal of its own up.",
  };
}

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

/**
 * deck.readPage -- ask the plugin's own page a question, and deck.waitFor --
 * ask it repeatedly until the answer arrives.
 *
 * The focus oracle answers exactly one question: where is the gamepad ring. That
 * is enough for a pure D-pad row and nothing else. Every real bug settled in the
 * first two days of driving a Deck needed a second question the oracle cannot
 * answer:
 *
 *   is the chip ladder mounted, and is it the transcript's or the strip's?
 *   is the masked spoiler fence wrapped in a <pre>?
 *   which Quick Access pane is actually on screen?
 *   has the reply finished, or is it still streaming?
 *   how many focusable controls does this tab have, and what are they called?
 *
 * All of those were answered with a throwaway script, which meant the most
 * load-bearing capability in the rig was the one thing not shipped.
 *
 * READ. DO NOT DRIVE.
 * =====================
 * This runs JavaScript in the Steam client, so it *can* change the page. It must
 * not be used to. A DOM write that makes the UI look right proves nothing about
 * whether a user could have got there with a controller, and a test that drives
 * the UI by script and then asserts the UI changed is the exact no-op-fix shape
 * this whole rig exists to eliminate. If you want the UI to change, press a
 * button and let Steam route it.
 *
 * There is deliberately no attempt to detect or block mutation. Pattern-matching
 * for `.value =` or `.click()` would refuse honest reads, wave through dishonest
 * ones, and buy a feeling of safety instead of the real thing. The real
 * protection is that fabricated state produces a wrong answer, and a wrong answer
 * is worse than no answer. Setup that genuinely needs a write -- typing a
 * question into a field, say -- belongs in a named, verified script that says so
 * out loud, the way bonsAI's `deck_send_ask.py` does.
 */
import { openCdpTunnel } from "./cdpTunnel.js";
import { listTargets, evaluate, rewriteWsHost, CdpTarget } from "./cdp.js";

/** Decky plugins render into the Quick Access Menu's own CEF target. */
const DEFAULT_TARGET = "QuickAccess_uid2";

export interface ReadPageResult<T = unknown> {
  ok: boolean;
  reason?: string;
  /** Whatever the expression evaluated to. Must be JSON-serialisable. */
  value: T | null;
  target: { title: string; url: string } | null;
  targetsScanned: string[];
  durationMs: number;
}

export interface ReadPageOptions {
  /** A JavaScript expression. Wrap statements in an IIFE: `(() => { ... })()`. */
  expression: string;
  /** CEF target title to run against. Defaults to the Quick Access Menu. */
  target?: string;
  cdpUrl?: string;
  timeoutMs?: number;
}

/**
 * Pick the target to run against.
 *
 * Exact title first, then a substring, then the QAM, then whatever is first.
 * Falling back rather than failing matters because target titles carry a `_uid2`
 * suffix that is not guaranteed stable across Steam builds.
 */
export function pickTarget(targets: CdpTarget[], wanted?: string): CdpTarget | null {
  if (targets.length === 0) return null;
  const want = (wanted ?? DEFAULT_TARGET).toLowerCase();
  return (
    targets.find((t) => (t.title ?? "").toLowerCase() === want) ??
    targets.find((t) => (t.title ?? "").toLowerCase().includes(want)) ??
    targets.find((t) => (t.title ?? "") === DEFAULT_TARGET) ??
    targets[0]
  );
}

async function evaluateAt<T>(
  base: string,
  expression: string,
  wanted: string | undefined,
  timeoutMs: number,
): Promise<ReadPageResult<T>> {
  const started = Date.now();
  const out: ReadPageResult<T> = {
    ok: false,
    value: null,
    target: null,
    targetsScanned: [],
    durationMs: 0,
  };

  let targets: CdpTarget[];
  try {
    targets = await listTargets(base, timeoutMs);
  } catch (err) {
    return {
      ...out,
      reason:
        `${(err as Error).message}. The Deck's CEF debugger has to be reachable: check that ` +
        "~/.steam/steam/.cef-enable-remote-debugging exists on the device and that the tunnel is up.",
      durationMs: Date.now() - started,
    };
  }

  out.targetsScanned = targets.map((t) => t.title ?? "(untitled)");
  const target = pickTarget(targets, wanted);
  if (!target?.webSocketDebuggerUrl) {
    return {
      ...out,
      reason: `No usable CEF target. Saw: ${out.targetsScanned.join(", ") || "none"}.`,
      durationMs: Date.now() - started,
    };
  }
  out.target = { title: target.title ?? "", url: target.url ?? "" };

  try {
    const value = await evaluate<T>(
      rewriteWsHost(target.webSocketDebuggerUrl, base),
      expression,
      timeoutMs,
    );
    return { ...out, ok: true, value, durationMs: Date.now() - started };
  } catch (err) {
    // A thrown expression is the common case and usually a typo, so say so
    // plainly rather than surfacing a protocol error.
    return {
      ...out,
      reason:
        `${(err as Error).message}. Note the expression must EVALUATE to a value -- ` +
        "wrap any statements in an IIFE, e.g. (() => { ...; return x; })(), and make sure " +
        "the result is JSON-serialisable (no DOM nodes, no functions).",
      durationMs: Date.now() - started,
    };
  }
}

export async function readPage<T = unknown>(opts: ReadPageOptions): Promise<ReadPageResult<T>> {
  const expression = (opts.expression ?? "").trim();
  const timeoutMs = opts.timeoutMs ?? 10_000;
  if (!expression) {
    return {
      ok: false,
      reason: "No expression given.",
      value: null,
      target: null,
      targetsScanned: [],
      durationMs: 0,
    };
  }

  if (opts.cdpUrl) return evaluateAt<T>(opts.cdpUrl, expression, opts.target, timeoutMs);

  let tunnel: { base: string; close: () => void };
  try {
    tunnel = await openCdpTunnel();
  } catch (err) {
    return {
      ok: false,
      reason: (err as Error).message,
      value: null,
      target: null,
      targetsScanned: [],
      durationMs: 0,
    };
  }
  try {
    return await evaluateAt<T>(tunnel.base, expression, opts.target, timeoutMs);
  } finally {
    tunnel.close();
  }
}

// --------------------------------------------------------------------------

export interface WaitForResult<T = unknown> extends ReadPageResult<T> {
  /** Did the condition hold before the timeout? */
  satisfied: boolean;
  polls: number;
  waitedMs: number;
}

export interface WaitForOptions extends ReadPageOptions {
  /** How long to keep asking. Default 30s. */
  waitMs?: number;
  /** Gap between reads. Default 500ms. */
  intervalMs?: number;
  /** Stop when the value equals this (JSON-compared). Omit to stop on any truthy value. */
  equals?: unknown;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Poll an expression until it is satisfied, over ONE tunnel.
 *
 * Waiting for a reply to finish, or a panel to mount, was hand-rolled four or
 * five times in the first two days -- each time as a shell loop that opened a
 * fresh tunnel per poll, which is about 350ms of SSH per read.
 *
 * A timeout is NOT an error: "the reply never finished within 60s" is a finding,
 * and the last value seen is returned so the caller can see how far it got.
 */
export async function waitFor<T = unknown>(opts: WaitForOptions): Promise<WaitForResult<T>> {
  const waitMs = opts.waitMs ?? 30_000;
  const intervalMs = Math.max(100, opts.intervalMs ?? 500);
  const started = Date.now();
  const hasExpected = Object.prototype.hasOwnProperty.call(opts, "equals");
  const expected = JSON.stringify(opts.equals ?? null);

  const satisfiedBy = (v: unknown): boolean =>
    hasExpected ? JSON.stringify(v ?? null) === expected : Boolean(v);

  const run = async (base: string): Promise<WaitForResult<T>> => {
    let polls = 0;
    let last: ReadPageResult<T> = {
      ok: false,
      value: null,
      target: null,
      targetsScanned: [],
      durationMs: 0,
    };

    for (;;) {
      last = await evaluateAt<T>(base, opts.expression, opts.target, opts.timeoutMs ?? 10_000);
      polls++;

      // A read that cannot run at all is a hard stop -- polling a broken tunnel
      // until the timeout just delays the same error.
      if (!last.ok) {
        return { ...last, satisfied: false, polls, waitedMs: Date.now() - started };
      }
      if (satisfiedBy(last.value)) {
        return { ...last, satisfied: true, polls, waitedMs: Date.now() - started };
      }
      if (Date.now() - started >= waitMs) {
        return {
          ...last,
          satisfied: false,
          polls,
          waitedMs: Date.now() - started,
          reason:
            `Condition still not met after ${Math.round((Date.now() - started) / 1000)}s ` +
            `and ${polls} read(s). The last value is in \`value\` -- that is the finding, not an error.`,
        };
      }
      await sleep(intervalMs);
    }
  };

  if (opts.cdpUrl) return run(opts.cdpUrl);

  let tunnel: { base: string; close: () => void };
  try {
    tunnel = await openCdpTunnel();
  } catch (err) {
    return {
      ok: false,
      reason: (err as Error).message,
      value: null,
      target: null,
      targetsScanned: [],
      durationMs: 0,
      satisfied: false,
      polls: 0,
      waitedMs: Date.now() - started,
    };
  }
  try {
    return await run(tunnel.base);
  } finally {
    tunnel.close();
  }
}

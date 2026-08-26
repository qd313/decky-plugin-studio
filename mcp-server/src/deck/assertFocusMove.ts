/**
 * deck.assertFocusMove -- press a button and report what Steam actually did.
 *
 * This is the tool a consumer calls, and the reason the oracle and the bridge
 * both exist. It reports `moved` and `matched` SEPARATELY, because those two
 * answer different questions and conflating them is the dead end bonsAI could
 * not get out of:
 *
 *   moved: false                  the press never arrived, or nothing is wired
 *   moved: true, matched: false   the press arrived and Steam sent focus
 *                                 somewhere else -- the wiring is wrong
 *   moved: true, matched: true    it worked
 *
 * A single boolean cannot distinguish "my handler is broken" from "my handler
 * never ran", and every hour spent on the wrong one of those is wasted.
 *
 * Settling is polled, never sampled once (decision 21). gpfocus was observed
 * updating ~400 ms after a handler call on one build; that is one data point,
 * not a constant, so this reads until the answer stops changing. Reading too
 * early yields a false negative, which is the same class of lie as a false
 * positive.
 */
import { openCdpTunnel } from "./cdpTunnel.js";
import { pressButton } from "./pressButton.js";
import { readFocusAt, ReadFocusResult } from "./readFocus.js";

export interface AssertFocusMoveResult {
  ok: boolean;
  reason?: string;
  fidelity: "steam-routed" | null;
  press: string[];
  expect: string | null;
  before: ReadFocusResult | null;
  after: ReadFocusResult | null;
  /** Did focus land on a different element than before the press? */
  moved: boolean;
  /** Did it land on `expect`? null when no expect was given, or the selector was invalid. */
  matched: boolean | null;
  /** Whether focus stopped changing before the timeout. */
  settled: boolean;
  settleMs: number;
  diagnosis: string;
}

export interface AssertFocusMoveOptions {
  press: string | string[];
  expect?: string;
  holdMs?: number;
  port?: string;
  cdpUrl?: string;
  /** How long to wait for focus to stop changing. */
  settleTimeoutMs?: number;
}

/**
 * Identity of a focused element across two reads.
 *
 * A verified selector is the strongest handle available. Without one, fall back
 * to tag + text + position -- deliberately NOT the element's own id, which on
 * Steam's React tree is regenerated per render and would make every read look
 * like a move.
 */
function focusKey(r: ReadFocusResult | null): string | null {
  const el = r?.gpfocus;
  if (!el) return null;
  if (el.selector && el.selectorVerified) return `sel:${el.selector}`;
  const rect = el.rect ? `${el.rect.x},${el.rect.y},${el.rect.w},${el.rect.h}` : "no-rect";
  return `id:${el.tag}|${el.text}|${rect}`;
}

function describe(r: ReadFocusResult | null): string {
  const el = r?.gpfocus;
  if (!el) return "nothing";
  return el.text ? `<${el.tag}> "${el.text}"` : `<${el.tag}>`;
}

const sleep = (ms: number): Promise<void> => new Promise((res) => setTimeout(res, ms));

export async function assertFocusMove(
  opts: AssertFocusMoveOptions,
): Promise<AssertFocusMoveResult> {
  const press = (Array.isArray(opts.press) ? opts.press : [opts.press]).map((b) =>
    b.trim().toUpperCase(),
  );
  const expect = opts.expect ?? null;
  const settleTimeoutMs = opts.settleTimeoutMs ?? 2500;

  const base: AssertFocusMoveResult = {
    ok: false,
    fidelity: null,
    press,
    expect,
    before: null,
    after: null,
    moved: false,
    matched: null,
    settled: false,
    settleMs: 0,
    diagnosis: "",
  };

  // One tunnel for the whole sequence. Opening one per read would add ~350ms to
  // every poll and make the settle measurement mostly measure SSH.
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
        reason: (err as Error).message,
        diagnosis: "could not reach the Deck, so nothing was pressed",
      };
    }
  }

  try {
    const before = await readFocusAt(cdpBase, 10_000, expect ?? undefined);
    if (!before.ok) {
      return {
        ...base,
        before,
        reason: before.reason,
        diagnosis: "could not read focus before the press, so nothing was pressed",
      };
    }

    // Refuse rather than degrade (E2). Nothing below runs without a real press.
    const pressed = await pressButton({ buttons: press, holdMs: opts.holdMs, port: opts.port });
    if (!pressed.ok) {
      return {
        ...base,
        before,
        reason: pressed.reason,
        diagnosis: "no press was delivered, so nothing can be concluded about the wiring",
      };
    }

    const beforeKey = focusKey(before);
    const started = Date.now();
    let after = before;
    let lastKey: string | null = null;
    let stableReads = 0;
    let settled = false;

    // Poll until the answer stops changing twice in a row.
    for (;;) {
      await sleep(120);
      after = await readFocusAt(cdpBase, 10_000, expect ?? undefined);
      const key = focusKey(after);

      if (key === lastKey) {
        stableReads++;
        // One stable pair is enough once focus has actually moved; when it has
        // not, wait for a second to avoid calling a slow move a non-move.
        if (stableReads >= (key !== beforeKey ? 1 : 2)) {
          settled = true;
          break;
        }
      } else {
        stableReads = 0;
      }
      lastKey = key;

      if (Date.now() - started > settleTimeoutMs) break;
    }

    const settleMs = Date.now() - started;
    const afterKey = focusKey(after);
    const moved = beforeKey !== afterKey;
    const matched = expect ? (after.matchesExpect ?? null) : null;

    let diagnosis: string;
    if (!moved) {
      diagnosis =
        `press routed, focus did not move - still ${describe(after)}. ` +
        (expect
          ? "the target never received it: either no handler is wired for this direction, or it ran and moved nothing"
          : "either no handler is wired for this direction, or it ran and moved nothing");
    } else if (matched === true) {
      diagnosis = `press routed, focus moved ${describe(before)} -> ${describe(after)}, matching expect`;
    } else if (matched === false) {
      diagnosis =
        `press routed, focus moved ${describe(before)} -> ${describe(after)} - ` +
        "the press arrived and Steam sent focus somewhere else, so the wiring is wrong " +
        "rather than missing";
    } else {
      diagnosis = `press routed, focus moved ${describe(before)} -> ${describe(after)}`;
    }
    if (!settled) {
      diagnosis += `; focus was still changing after ${settleTimeoutMs}ms, so this reading may be early`;
    }
    if (after.ok && !after.agree) {
      diagnosis +=
        "; note gpfocus and activeElement disagree here - anything asserting on " +
        "activeElement would report a different answer";
    }

    return {
      ok: true,
      fidelity: "steam-routed",
      press,
      expect,
      before,
      after,
      moved,
      matched,
      settled,
      settleMs,
      diagnosis,
    };
  } finally {
    closeTunnel?.();
  }
}

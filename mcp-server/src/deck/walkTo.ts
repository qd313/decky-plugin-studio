/**
 * deck.walkTo -- move the focus ring one direction until it lands on a named
 * control, reading after every single press.
 *
 * This was the most-used thing in the first two days of driving a Deck, and for
 * a while it was a scratchpad script rather than a tool, which is backwards.
 * Almost every QA row starts with "get the ring onto X" and only then asserts
 * something; without this, that first half is a human reading focus dumps and
 * deciding to press again. Navigation, not assertion, is where the time goes.
 *
 * It never presses A, B or START. Direction presses move the ring and nothing
 * else, so a walk cannot activate a control, launch a game, or leave the screen
 * it started on. Acting on what it finds is the caller's job, and the caller
 * gets the read that justifies it.
 *
 * Three things it learned from hardware:
 *
 *   MATCHING IS SUBSTRING BY DEFAULT, AND THAT CUTS BOTH WAYS. Walking to "ask"
 *   stopped on "Attach screenshot to Ask" -- the wrong control, one press before
 *   the right one, and pressing A there would have attached a screenshot. The
 *   match is always reported back so a caller can check it, and `exact` is there
 *   for when the name is a common word.
 *
 *   LABELS OFTEN LIVE ON AN ANCESTOR, BUT AN ANCESTOR MUST NOT WIN. Decky's
 *   ToggleField puts the ring on an unlabelled inner div with the text several
 *   parents up, so matching only the focused element's own text misses every
 *   toggle in a settings page. Letting that climb run unchecked is worse: an
 *   icon-only tab has no text either, and its nearest texted ancestor was the
 *   entire Quick Access Menu, which substring-matched "bonsAI" and reported
 *   found after ZERO presses (P1-10). The name now resolves aria-label first and
 *   refuses text too long to be a name -- see FocusElement.label.
 *
 *   DEAD ENDS ARE COMMON AND SHOULD STOP THE WALK. At the bottom of a list the
 *   ring simply stops moving. Sixteen more presses cost sixteen round trips and
 *   learn nothing, so a walk that stops making progress gives up and says so.
 */
import { openCdpTunnel } from "./cdpTunnel.js";
import { pressButton } from "./pressButton.js";
import { readFocusAt, ReadFocusResult } from "./readFocus.js";
import { focusKey, describe, labelOfElement } from "./focusKey.js";
import { automationStopped, stoppedMessage } from "./killswitch.js";

export type WalkDirection = "UP" | "DOWN" | "LEFT" | "RIGHT";

export interface WalkToOptions {
  direction: WalkDirection;
  /** Text to look for on the focused control, or on its nearest labelled ancestor. */
  text: string;
  /** Max presses. Default 20. */
  budget?: number;
  /** Require the whole label to equal `text` rather than contain it. */
  exact?: boolean;
  /** Give up after this many presses that do not move the ring. Default 3. */
  stallLimit?: number;
  /**
   * When nothing owns the gamepad ring, spend one press placing it and carry on.
   *
   * Opening a Decky plugin leaves focus unowned -- platform behaviour, measured,
   * see planning doc 03 -- and so does finishing an Ask. That state caught every
   * early session: the walk would refuse, a human would press Down by hand, and
   * the walk would then work. Default true, because "place the ring first" is
   * the only sensible thing to do and making the caller remember it is just a
   * tax. Set false when the unowned state is itself what you are testing.
   */
  acquireFocus?: boolean;
  port?: string;
  cdpUrl?: string;
}

export interface WalkToResult {
  ok: boolean;
  found: boolean;
  reason?: string;
  fidelity: "steam-routed" | null;
  direction: WalkDirection;
  text: string;
  /** The label actually matched. Check this -- a substring match can land next door. */
  matched: string | null;
  presses: number;
  /** Distinct labels seen, in order. The useful half of a miss. */
  seen: string[];
  focus: ReadFocusResult | null;
  /** True when the walk stopped because the ring stopped moving. */
  stalled: boolean;
  /**
   * True when at least one read landed on something too big to be a control --
   * the ring is on a container, and the rig refused to name it after a pane
   * dump. Reported because "nothing was labelled" and "the walk overshot onto a
   * container" send a reader to very different places.
   */
  overshot: boolean;
  /** True when a press was spent placing an unowned ring before the walk began. */
  acquired: boolean;
  /** True when the walk ended because the killswitch was thrown. */
  stopped: boolean;
  summary: string;
}

const DIRECTIONS: WalkDirection[] = ["UP", "DOWN", "LEFT", "RIGHT"];

/**
 * The focused control's name -- computed on the page by readFocus, ranked in one
 * place by labelOfElement, so walkTo, runSequence and openPlugin cannot drift
 * apart on what a control is called. See FocusElement.label for why this stopped
 * being three fields ordered ad hoc at each call site.
 */
export function labelOf(r: ReadFocusResult | null): string {
  return labelOfElement(r?.gpfocus ?? null);
}

function matches(label: string, needle: string, exact: boolean): boolean {
  if (!label) return false;
  return exact
    ? label.toLowerCase() === needle.toLowerCase()
    : label.toLowerCase().includes(needle.toLowerCase());
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface AcquireFocusOptions {
  /** CDP base to re-read from after the placing press. */
  cdpBase: string;
  /** Which D-pad direction to press. Placement, not movement -- see below. */
  direction: WalkDirection;
  port?: string;
  /**
   * Test-only seam: substitutes the press used to place an unowned ring, so
   * this can be exercised without the bridge board. Production code -- both
   * walkTo and runSequence -- always leaves this unset and gets the real
   * bridge press.
   */
  pressFn?: typeof pressButton;
}

export interface AcquireFocusOutcome {
  focus: ReadFocusResult;
  acquired: boolean;
  presses: number;
}

/**
 * If `focus` shows nothing owns the ring, spend one D-pad press placing it and
 * re-read. A no-op otherwise -- including when the ring is unreadable for some
 * reason other than "nothing owns it yet", e.g. the Deck is unreachable.
 *
 * Shared by walkTo and runSequence: both start every run by asking "does
 * anything own the ring", and both need the identical answer to "no" (doc 03
 * -- unowned is the normal state after a plugin opens or an Ask finishes, not
 * an edge case). Any D-pad direction places it -- Decky lands the ring on the
 * plugin's topmost control regardless of which way was pressed -- so the
 * direction passed in only matters for the walk that follows, not for this
 * placement itself.
 */
export async function acquireFocusIfUnowned(
  focus: ReadFocusResult,
  opts: AcquireFocusOptions,
): Promise<AcquireFocusOutcome> {
  const unowned = !focus.ok && (focus.reason ?? "").includes("gpfocus marker not found");
  if (!unowned) return { focus, acquired: false, presses: 0 };

  const press = opts.pressFn ?? pressButton;
  const p = await press({ buttons: [opts.direction], port: opts.port });
  if (!p.ok) return { focus, acquired: false, presses: 0 };

  await sleep(250);
  const reread = await readFocusAt(opts.cdpBase, 10_000);
  return { focus: reread, acquired: true, presses: 1 };
}

export async function walkTo(opts: WalkToOptions): Promise<WalkToResult> {
  const direction = (opts.direction ?? "").toString().toUpperCase() as WalkDirection;
  const text = opts.text ?? "";
  const budget = opts.budget ?? 20;
  const exact = opts.exact === true;
  const stallLimit = opts.stallLimit ?? 3;

  const base: WalkToResult = {
    ok: false,
    found: false,
    fidelity: null,
    direction,
    text,
    matched: null,
    presses: 0,
    seen: [],
    focus: null,
    stalled: false,
    overshot: false,
    acquired: false,
    stopped: false,
    summary: "",
  };

  if (!DIRECTIONS.includes(direction)) {
    return {
      ...base,
      reason: `walkTo only moves the ring: direction must be one of ${DIRECTIONS.join(", ")}. ` +
        "A, B and START are refused here because a walk must not be able to activate anything.",
      summary: "refused: not a direction",
    };
  }
  if (!text.trim()) {
    return { ...base, reason: "No text to look for.", summary: "refused: nothing to look for" };
  }

  // Before the tunnel, not just before the first press: a stopped rig should not
  // spend SSH setup on a walk that cannot take a single step.
  const latched = automationStopped();
  if (latched) {
    return {
      ...base,
      stopped: true,
      reason: stoppedMessage(latched),
      summary: "refused: Deck automation is stopped, so nothing was pressed",
    };
  }

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
        summary: "could not reach the Deck, so nothing was pressed",
      };
    }
  }

  const seen: string[] = [];
  let presses = 0;
  let stalls = 0;
  let stalled = false;
  let overshot = false;

  try {
    let focus = await readFocusAt(cdpBase, 10_000);
    let acquired = false;

    // Unowned ring: one press places it rather than moving it, so spend that
    // press here and re-read before the walk proper begins.
    if (opts.acquireFocus !== false) {
      const outcome = await acquireFocusIfUnowned(focus, { cdpBase, direction, port: opts.port });
      focus = outcome.focus;
      acquired = outcome.acquired;
      presses += outcome.presses;
    }

    if (!focus.ok) {
      return {
        ...base,
        focus,
        presses,
        acquired,
        reason: focus.reason,
        summary: acquired
          ? `spent one press trying to place an unowned ring and focus is still unreadable: ${focus.reason ?? ""}`
          : "could not read focus before the walk started, so nothing was pressed. " +
            "If the ring is unowned -- which it is right after a plugin opens -- one press " +
            "places it; acquireFocus does that automatically and is on by default.",
      };
    }

    for (;;) {
      // The press refuses on the latch too, so nothing can escape. Checking here
      // is what makes a stopped walk report itself as stopped instead of as
      // "no press could be delivered", which reads like a broken bridge.
      const midWalk = automationStopped();
      if (midWalk) {
        return {
          ...base,
          presses,
          seen,
          focus,
          overshot,
          acquired,
          stopped: true,
          reason: stoppedMessage(midWalk),
          summary:
            `KILLSWITCH: the walk was stopped by hand after ${presses} press(es), ` +
            `without finding "${text}". Seen: ${seen.join(" | ") || "nothing labelled"}`,
        };
      }

      const label = labelOf(focus);
      if (label && !seen.includes(label)) seen.push(label);
      if (focus.gpfocus?.labelOverflow) overshot = true;

      if (matches(label, text, exact)) {
        return {
          ok: true,
          found: true,
          fidelity: presses > 0 ? "steam-routed" : null,
          direction,
          text,
          matched: label,
          presses,
          seen,
          focus,
          stalled: false,
          overshot,
          acquired,
          stopped: false,
          summary:
            `found after ${presses} press(es): ${describe(focus)}` +
            (exact || label.toLowerCase() === text.toLowerCase()
              ? ""
              : ` -- matched as a substring, so check this is the control you meant`),
        };
      }

      if (presses >= budget) break;

      const before = focusKey(focus);
      const p = await pressButton({ buttons: [direction], port: opts.port });
      if (!p.ok) {
        return {
          ...base,
          presses,
          seen,
          focus,
          overshot,
          reason: p.reason,
          summary: `no press could be delivered after ${presses} step(s)`,
        };
      }
      presses++;
      await sleep(200);
      focus = await readFocusAt(cdpBase, 10_000);
      if (!focus.ok) {
        return {
          ...base,
          presses,
          seen,
          focus,
          overshot,
          reason: focus.reason,
          summary: `focus became unreadable after ${presses} press(es)`,
        };
      }

      // A ring that stops moving is at a dead end. Spending the rest of the
      // budget on it costs a round trip per press and learns nothing.
      if (focusKey(focus) === before) {
        stalls++;
        if (stalls >= stallLimit) {
          stalled = true;
          break;
        }
      } else {
        stalls = 0;
      }
    }

    return {
      ...base,
      ok: true,
      found: false,
      fidelity: presses > 0 ? "steam-routed" : null,
      presses,
      seen,
      focus,
      stalled,
      overshot,
      acquired,
      summary:
        (stalled
          ? `the ring stopped moving after ${presses} press(es) without finding "${text}" - ` +
            `this is the end of the line going ${direction}. Seen: ${seen.join(" | ") || "nothing labelled"}`
          : `walked ${presses} control(s) without finding "${text}". ` +
            `Seen: ${seen.join(" | ") || "nothing labelled"}`) +
        (overshot
          ? " - at least one stop had no name of its own and the only text around it was a whole " +
            "container's, so it was left unnamed rather than reported under a pane's text"
          : ""),
    };
  } finally {
    closeTunnel?.();
  }
}

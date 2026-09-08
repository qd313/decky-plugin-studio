/**
 * How much a result is allowed to claim about a press that was sent.
 *
 * Lane 6 (2026-09-07) made `deck_pressButton` honest: the bridge firmware acks
 * a press whether or not its HID side reaches anything, so an ack proves the
 * press left the host and nothing more. That is `"wire-sent"`. The stronger
 * `"steam-routed"` has to be EARNED, by reading Steam's own gamepad focus
 * before and after and seeing it change.
 *
 * The leaf was fixed and six callers were not. `assertFocusMove`, `walkTo`,
 * `sweep`, `openPlugin`, `runSequence` and `gameSession` each hardcoded
 * `fidelity: "steam-routed"` from `presses > 0` -- a press *count* -- and none
 * of them read the field `pressButton` had started returning. So a whole sweep
 * reported `steam-routed` down a physically dead wire exactly as a single
 * press used to: the same false claim, one level up, at a coarser grain.
 *
 * This module exists so the fix is defined once. Six files each folding their
 * own answer is how `checks/buildHash.ts` and `deck/buildHash.ts` ended up
 * being two different correct fingerprints that could not be compared.
 *
 * The ordering is a floor, not a verdict. `"wire-sent"` does not mean the
 * press failed to route -- a handler may well have run and moved nothing --
 * it means nothing here is entitled to say that it did.
 */

/** null = no press was delivered, so there is nothing to claim either way. */
export type Fidelity = "wire-sent" | "steam-routed" | null;

const RANK: Record<string, number> = { "wire-sent": 1, "steam-routed": 2 };

/**
 * The weakest claim any press in a run earned -- the only claim the run as a
 * whole is entitled to make.
 *
 * A multi-press tool is exactly as trustworthy as its least-verified press: a
 * twenty-press sweep in which nineteen moved focus and one did not has not
 * established that the twentieth went anywhere. Reporting the best, or the
 * average, or "some press worked" would hide the single dead press this
 * distinction exists to surface.
 *
 * An empty list, or one with nothing but nulls, is `null`: no press was
 * delivered, which is different from a press that was delivered unverified.
 */
export function weakestFidelity(seen: ReadonlyArray<Fidelity>): Fidelity {
  let worst: Fidelity = null;
  let worstRank = Infinity;
  for (const f of seen) {
    if (f === null || f === undefined) continue;
    const rank = RANK[f] ?? Infinity;
    if (rank < worstRank) {
      worstRank = rank;
      worst = f;
    }
  }
  return worst;
}

/**
 * What a single press earned, given whether focus was observed to change.
 *
 * `moved === true` is the same evidence `pressButton`'s own `verify: true`
 * uses, so a caller that already reads focus either side of a press -- which
 * assertFocusMove and walkTo both do, for their own reasons -- earns the
 * stronger value at no extra cost. Callers with no such read pass `false` and
 * report the floor.
 */
export function earnedFidelity(moved: boolean): Fidelity {
  return moved ? "steam-routed" : "wire-sent";
}

/**
 * What a multi-press tool earned when it never checked focus per press, but
 * DID confirm the end state it was driving toward by reading the Deck.
 *
 * `openPlugin` and `gameSession` press without verifying each one, so neither
 * can say which individual press routed. What they can say is stronger in a
 * different direction: a plugin panel that a DOM read now finds on screen, or
 * an app id that has appeared in Steam's own `RunningApps`, could not have got
 * there through presses that never reached Steam. The end state IS the
 * evidence, so a confirmed one earns `"steam-routed"` honestly.
 *
 * When the tool did not reach that end state -- it failed, was stopped, or
 * bailed out early -- the presses were still delivered and nothing about their
 * routing was established. That is `"wire-sent"`, which is the case this
 * whole module exists for: before 2026-09-08 those paths reported
 * `"steam-routed"` off `presses > 0`, so a run that pressed twenty times down
 * a dead wire and then failed still claimed Steam had received every one.
 */
export function confirmedFidelity(presses: number, confirmedByRead: boolean): Fidelity {
  if (presses <= 0) return null;
  return confirmedByRead ? "steam-routed" : "wire-sent";
}

/**
 * Tests for deck.fidelity -- how much a result is allowed to claim.
 *
 * Pure functions: no CDP, no bridge board, no Deck. What they encode is the
 * fix for the open bug of 2026-09-07: six tools derived
 * `fidelity: "steam-routed"` from a press COUNT, so a twenty-press sweep down
 * a physically dead wire reported every press as having reached Steam. The
 * rule here is that a run may claim only as much as its weakest press.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { confirmedFidelity, earnedFidelity, weakestFidelity, type Fidelity } from "./fidelity.js";

test("no press at all is null -- not a claim in either direction", () => {
  assert.equal(weakestFidelity([]), null);
  assert.equal(weakestFidelity([null, null]), null);
});

test("one unverified press drags a run of verified ones down to wire-sent", () => {
  // The bug this module exists for, in one line: nineteen presses that moved
  // focus establish nothing about a twentieth that did not, and the twentieth
  // is the one worth knowing about.
  const run: Fidelity[] = Array<Fidelity>(19).fill("steam-routed");
  run.push("wire-sent");
  assert.equal(weakestFidelity(run), "wire-sent");
});

test("a run whose every press was verified keeps the stronger value", () => {
  assert.equal(weakestFidelity(["steam-routed", "steam-routed", "steam-routed"]), "steam-routed");
});

test("the weakest wins wherever in the run it sits", () => {
  assert.equal(weakestFidelity(["wire-sent", "steam-routed"]), "wire-sent");
  assert.equal(weakestFidelity(["steam-routed", "wire-sent"]), "wire-sent");
});

test("nulls are skipped, not treated as the weakest", () => {
  // A null means "no press happened here", which must not drag a run of real
  // presses down to "nothing was pressed".
  assert.equal(weakestFidelity([null, "steam-routed", null]), "steam-routed");
  assert.equal(weakestFidelity([null, "wire-sent"]), "wire-sent");
});

test("earnedFidelity: whether focus moved is the whole difference", () => {
  assert.equal(earnedFidelity(true), "steam-routed");
  assert.equal(earnedFidelity(false), "wire-sent");
});

test("confirmedFidelity: no press is null, whatever else was confirmed", () => {
  assert.equal(confirmedFidelity(0, true), null);
  assert.equal(confirmedFidelity(0, false), null);
});

test("confirmedFidelity: presses plus a confirmed end state earn the stronger value", () => {
  // An open plugin panel, or an app id that has appeared in Steam's own
  // RunningApps, is not reachable by presses that never got to Steam.
  assert.equal(confirmedFidelity(5, true), "steam-routed");
});

test("confirmedFidelity: presses with nothing confirmed report the floor", () => {
  // Exactly the path that used to answer "steam-routed" off `presses > 0`.
  assert.equal(confirmedFidelity(20, false), "wire-sent");
});

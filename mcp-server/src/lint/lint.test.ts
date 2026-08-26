/**
 * Focus linter rule tests.
 *
 * Each rule gets a good fixture and a bad one. Assertions are scoped to the
 * rule under test: a fixture built to trip R3 will often also trip R2, and
 * asserting on a total would make every test brittle against unrelated rule
 * changes.
 *
 * The "not analyzed" assertions matter as much as the warning ones. A silent
 * skip is the failure mode this linter exists to remove, so it is tested, not
 * assumed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { lintFocus } from "./index.js";
import { RuleId } from "./types.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name: string): string => path.join(here, "__fixtures__", name);

function warnings(name: string, rule: RuleId) {
  return lintFocus(fixture(name)).warnings.filter((w) => w.rule === rule);
}

test("R1: a reversible pair produces no one-way warning", () => {
  assert.equal(warnings("r1-good", "R1").length, 0);
});

test("R1: a one-way move produces exactly one warning", () => {
  const found = warnings("r1-bad", "R1");
  assert.equal(found.length, 1);
  assert.match(found[0].headline, /one-way move/);
  assert.match(found[0].action, /onMoveUp/);
});

test("R2: fully wired stops are all reachable", () => {
  assert.equal(warnings("r2-good", "R2").length, 0);
});

test("R2: an orphan stop is reported once", () => {
  const found = warnings("r2-bad", "R2");
  assert.equal(found.length, 1);
  assert.match(found[0].headline, /<Button> cannot be reached/);
});

test("R2: a file with unresolved refs is not judged, it is reported", () => {
  // r1-bad resolves everything, so reachability runs. The contrast that matters
  // is that an unresolved reference suppresses the rule rather than guessing.
  const res = lintFocus(fixture("unknown-component"));
  const reachability = res.warnings.filter((w) => w.rule === "R2");
  const gaps = res.notAnalyzed.filter((n) => n.reason === "unknown-component");
  assert.ok(gaps.length > 0, "an unknown component must be reported, never assumed inert");
  assert.equal(reachability.length, 0, "reachability must not run on a file it cannot resolve");
});

test("R3: a wrapper Focusable with an actioned child is fine", () => {
  assert.equal(warnings("r3-good", "R3").length, 0);
});

test("R3: a button with no handler is reported", () => {
  const found = warnings("r3-bad", "R3");
  assert.equal(found.length, 1);
  assert.match(found[0].headline, /no A-button action/);
});

test("R4: registered refs produce no activeElement warning", () => {
  assert.equal(warnings("r4-good", "R4").length, 0);
});

test("R4: document.activeElement in a move handler is reported once", () => {
  const found = warnings("r4-bad", "R4");
  assert.equal(found.length, 1);
  assert.match(found[0].headline, /activeElement is not a focus oracle/);
});

test("R5: registered refs produce no page-search warning", () => {
  assert.equal(warnings("r5-good", "R5").length, 0);
});

test("R5: querySelector in a move handler is reported", () => {
  const found = warnings("r5-bad", "R5");
  assert.equal(found.length, 1);
  assert.match(found[0].headline, /searching the page/);
});

test("R11: a toggle revealing focus stops is reported with a count", () => {
  const found = warnings("r11-bad", "R11");
  assert.equal(found.length, 1);
  assert.match(found[0].headline, /reveals 2 focus stops/);
  assert.match(found[0].action, /focus-states\.json/);
});

test("R11: declaring the state clears the warning", () => {
  // Decision 11: a declaration is the only way to clear this. Same source as
  // r11-bad; the only difference is .decky/focus-states.json.
  assert.equal(warnings("r11-good", "R11").length, 0);
});

test("R12: stops built from backend data are reported", () => {
  const found = warnings("r12-bad", "R12");
  assert.equal(found.length, 1);
  assert.match(found[0].headline, /fills after a backend call/);
});

test("an unresolvable custom component lands in notAnalyzed, not in stops", () => {
  const res = lintFocus(fixture("unknown-component"));
  const gap = res.notAnalyzed.find((n) => n.detail.includes("SpoilerFence"));
  assert.ok(gap, "SpoilerFence must be reported as unanalyzed");
  assert.equal(gap.reason, "unknown-component");
});

test("the not-analyzed block is always rendered, even when empty", () => {
  const clean = lintFocus(fixture("r1-good"));
  assert.equal(clean.notAnalyzed.length, 0);
  assert.match(clean.text, /not analyzed: none/);
});

test("the summary reports stops and files checked", () => {
  const res = lintFocus(fixture("r1-good"));
  assert.equal(res.stopsChecked, 2);
  assert.equal(res.filesChecked, 1);
  assert.match(res.text, /2 stops checked across 1 file/);
});

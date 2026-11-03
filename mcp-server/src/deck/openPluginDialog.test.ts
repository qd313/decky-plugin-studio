/**
 * Tests for naming the dialog that took the ring (plan 12 lane A, item 4).
 *
 * On this-pc (2026-10-08) deck_openPlugin said "the panel did not mount" while
 * bonsAI's first-run dialog held the ring. When the mount check fails and the
 * read after the press puts the ring inside a modal or a dialog, the failure
 * now names it and its focused control, and nothing more is pressed.
 *
 * Only ModalDialogOverlay has been read on a Deck (gameSession.ts). Where
 * bonsAI's first-run dialog renders, and under which markup, has not been read
 * on any machine; the Big Picture page below is this test's assumption.
 */
process.env.DPS_NO_BRIDGE ??= "1";

import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";

import { startFakeCdp, focusedPage, unfocusedPage } from "./__testutil__/fakeCdp.js";
import { sandboxHome } from "./__testutil__/sandboxHome.js";
import { openPluginDriven, RING_DIALOG_EXPRESSION } from "./openPlugin.js";
import { QUICK_ACCESS_PROBE_EXPRESSION } from "./readFocus.js";
import type { PressOptions, PressResult } from "./pressButton.js";

sandboxHome("dps-open-dialog-");

const BIG_PICTURE = "Steam Big Picture Mode";
const TARGETS = ["SharedJSContext", BIG_PICTURE, "QuickAccess_uid2"];
const PROBE_OPEN_DECKY = { visiblePane: "999", ownsFocus: true, paneCount: 5, deckyPaneMounted: true };

/** After A: the ring on a dialog's button in the Big Picture page. */
const RING_IN_MODAL = {
  ...focusedPage,
  gpfocus: {
    ...focusedPage.gpfocus,
    selector: "#ModalDialogOverlay_Modal_0 > div.DialogContent > button.DialogButton",
    text: "Get started",
    ownerText: "Get started",
  },
  quickAccessTab: null,
  visibleQuickAccessTab: null,
  deckyPluginRoot: false,
};
/** After A: the ring on a library tile, no dialog anywhere. */
const RING_ON_TILE = {
  ...RING_IN_MODAL,
  gpfocus: { ...RING_IN_MODAL.gpfocus, selector: "#library > div.tile", text: "Doom 64", ownerText: "Doom 64" },
};

function recorder() {
  const log: string[] = [];
  const ok = (buttons: string[], method: string): PressResult => ({ ok: true, fidelity: "steam-routed", method, buttons, holdMs: 80 });
  return {
    log,
    pressed: (b: string) => log.includes(`press:${b}`),
    pressFn: async ({ buttons }: PressOptions): Promise<PressResult> => {
      log.push(`press:${buttons.join("+")}`);
      return ok(buttons, "fake");
    },
    chordFn: async (hold: string, tap: string): Promise<PressResult> => {
      log.push(`chord:${hold}>${tap}`);
      return ok([hold, tap], "fake:chord");
    },
  };
}

/** The panel never mounts; after A, Big Picture's page shows `afterA` and answers the dialog read with `dialogAnswer`. */
function deck(rig: ReturnType<typeof recorder>, afterA: unknown, dialogAnswer: unknown) {
  return (title: string, _i: number, expr: string): unknown => {
    if (expr === QUICK_ACCESS_PROBE_EXPRESSION) return title === "QuickAccess_uid2" ? PROBE_OPEN_DECKY : null;
    if (expr.includes(".bonsai-scope")) return false;
    if (expr.includes("dps:ring-dialog")) return title === BIG_PICTURE ? dialogAnswer : null;
    const a = rig.pressed("A");
    if (title === BIG_PICTURE) return a ? afterA : unfocusedPage;
    if (title === "QuickAccess_uid2") return a ? unfocusedPage : focusedPage;
    return unfocusedPage;
  };
}

async function openWith(afterA: unknown, dialogAnswer: unknown) {
  const rig = recorder();
  const fake = await startFakeCdp(TARGETS, deck(rig, afterA, dialogAnswer));
  try {
    const r = await openPluginDriven({
      pluginName: "bonsAI",
      cdpUrl: fake.base,
      restartMachine: "dialog-tests",
      rootSelector: ".bonsai-scope",
      targetsSettleMs: 100,
      pressFn: rig.pressFn,
      chordFn: rig.chordFn,
    });
    return { r, rig };
  } finally {
    await fake.close();
  }
}

test("A pressed, the panel did not mount, and a dialog holds the ring: the failure names the dialog and its focused control", async () => {
  const { r, rig } = await openWith(RING_IN_MODAL, {
    container: '[id^="ModalDialogOverlay"] #ModalDialogOverlay_Modal_0',
    title: "Welcome to bonsAI",
    evidence: "measured",
  });
  assert.equal(r.ok, false);
  assert.deepEqual(rig.log, ["press:A"], "nothing more is pressed into the dialog");
  assert.deepEqual(r.dialog, {
    target: BIG_PICTURE,
    title: "Welcome to bonsAI",
    focusedControl: "Get started",
    container: '[id^="ModalDialogOverlay"] #ModalDialogOverlay_Modal_0',
    evidence: "measured",
  });
  assert.match(r.reason ?? "", /panel did not mount: a dialog holds the ring: "Welcome to bonsAI" in Steam Big Picture Mode/);
  assert.match(r.reason ?? "", /focused control "Get started"/);
  assert.match(r.summary, /a dialog took the ring/);
  assert.doesNotMatch(r.reason ?? "", /never measured/, "the measured marker is not called a guess");
  assert.match(r.stages.find((s) => s.stage === "activate")?.detail ?? "", /a dialog holds the ring/);
});

test("the page cannot name the dialog, but the ring's selector is inside the measured ModalDialogOverlay: named untitled", async () => {
  const { r } = await openWith(RING_IN_MODAL, null);
  assert.equal(r.dialog?.title, null);
  assert.equal(r.dialog?.focusedControl, "Get started");
  assert.equal(r.dialog?.evidence, "measured");
  assert.match(r.dialog?.container ?? "", /from the focus read's selector #ModalDialogOverlay_Modal_0/);
  assert.match(r.reason ?? "", /an untitled dialog/);
});

test("a dialog found only by an unmeasured marker says so", async () => {
  const { r } = await openWith(RING_ON_TILE, { container: '[role="dialog"]', title: "First run", evidence: "unmeasured" });
  assert.equal(r.dialog?.evidence, "unmeasured");
  assert.match(r.reason ?? "", /a marker never measured on a Deck/);
});

test("no dialog: the old message stands, with where the ring is", async () => {
  const { r } = await openWith(RING_ON_TILE, null);
  assert.equal(r.ok, false);
  assert.equal(r.dialog, undefined);
  assert.match(r.reason ?? "", /the panel did not mount \("\.bonsai-scope" is absent\)/);
  assert.match(r.stages.find((s) => s.stage === "activate")?.detail ?? "", /the ring is on/);
});

// ---- the page-side expression, run against a small fake DOM -----------------

function fakeDocument(box: Record<string, unknown> | null, matches: string | null) {
  const focused = { closest: (sel: string) => (sel === matches ? box : null) };
  return {
    querySelector: (sel: string) => (sel === ".gpfocus" ? focused : null),
    getElementById: (id: string) => (id === "dlg-title" ? { textContent: " Set up bonsAI " } : null),
  };
}

/** Serialized by value, as Runtime.evaluate with returnByValue does (and out of the vm's realm). */
const run = (doc: unknown): unknown => JSON.parse(JSON.stringify(vm.runInNewContext(RING_DIALOG_EXPRESSION, { document: doc }) ?? null));

test("RING_DIALOG_EXPRESSION: a ModalDialogOverlay with a DialogHeader is named from the header, as measured", () => {
  const box = {
    id: "ModalDialogOverlay_Modal_0",
    querySelector: (s: string) => (s.startsWith(".DialogHeader") ? { textContent: "  Welcome to bonsAI " } : null),
    getAttribute: () => null,
    innerText: "Welcome to bonsAI\nGet started",
  };
  assert.deepEqual(run(fakeDocument(box, '[id^="ModalDialogOverlay"]')), {
    container: '[id^="ModalDialogOverlay"] #ModalDialogOverlay_Modal_0',
    title: "Welcome to bonsAI",
    evidence: "measured",
  });
});

test("RING_DIALOG_EXPRESSION: a role=dialog named by aria-labelledby, unmeasured; the first line of its text when nothing names it", () => {
  const labelled = {
    id: "",
    querySelector: () => null,
    getAttribute: (a: string) => (a === "aria-labelledby" ? "dlg-title" : null),
    innerText: "",
  };
  assert.deepEqual(run(fakeDocument(labelled, '[role="dialog"]')), {
    container: '[role="dialog"]',
    title: "Set up bonsAI",
    evidence: "unmeasured",
  });
  const bare = { id: "", querySelector: () => null, getAttribute: () => null, innerText: "Pick a model\nOK\nCancel" };
  assert.equal((run(fakeDocument(bare, '[role="dialog"]')) as { title: string }).title, "Pick a model");
});

test("RING_DIALOG_EXPRESSION: no dialog around the ring, or no ring, is null", () => {
  assert.equal(run(fakeDocument(null, null)), null);
  assert.equal(run({ querySelector: () => null, getElementById: () => null }), null);
});

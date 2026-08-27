/*
 * Hardware guard -- see pressButton.bridgeDisabled. readPage never presses, but
 * the suite sets this everywhere so no run can reach a board by accident.
 */
process.env.DPS_NO_BRIDGE ??= "1";

import { test } from "node:test";
import assert from "node:assert/strict";

import { startFakeCdp } from "./__testutil__/fakeCdp.js";
import { readPage, waitFor, pickTarget } from "./readPage.js";
import type { CdpTarget } from "./cdp.js";

const target = (title: string): CdpTarget =>
  ({ id: title, type: "page", title, url: "about:blank", webSocketDebuggerUrl: "ws://x/y" }) as CdpTarget;

test("an empty expression is refused rather than evaluated", async () => {
  const r = await readPage({ expression: "   " });
  assert.equal(r.ok, false);
  assert.match(r.reason ?? "", /No expression given/);
});

test("an unreachable Deck explains what to check", async () => {
  const r = await readPage({ expression: "1", cdpUrl: "http://127.0.0.1:1", timeoutMs: 1200 });
  assert.equal(r.ok, false);
  assert.match(r.reason ?? "", /cef-enable-remote-debugging/);
});

test("the value comes back as data, and the target is reported", async () => {
  const fake = await startFakeCdp(["QuickAccess_uid2"], () => ({ ladders: 1, inStrip: false }));
  try {
    const r = await readPage<{ ladders: number }>({ expression: "1", cdpUrl: fake.base });
    assert.equal(r.ok, true);
    assert.deepEqual(r.value, { ladders: 1, inStrip: false });
    assert.equal(r.target?.title, "QuickAccess_uid2");
  } finally {
    await fake.close();
  }
});

test("an expression that throws says how to write one that does not", async () => {
  // The usual mistake is pasting statements instead of an expression, and the
  // raw protocol error says nothing useful about that.
  const fake = await startFakeCdp(["QuickAccess_uid2"], () => ({
    __throw: "SyntaxError: Unexpected token 'const'",
  }));
  try {
    const r = await readPage({ expression: "const x = 1;", cdpUrl: fake.base });
    assert.equal(r.ok, false);
    assert.match(r.reason ?? "", /wrap any statements in an IIFE/);
  } finally {
    await fake.close();
  }
});

test("the Quick Access target is preferred, because that is where plugins render", () => {
  const targets = [target("SharedJSContext"), target("MainMenu_uid2"), target("QuickAccess_uid2")];
  assert.equal(pickTarget(targets)?.title, "QuickAccess_uid2");
  assert.equal(pickTarget(targets, "MainMenu_uid2")?.title, "MainMenu_uid2");
  // Substring, because the _uid2 suffix is not promised to be stable.
  assert.equal(pickTarget(targets, "mainmenu")?.title, "MainMenu_uid2");
  // Unknown name falls back rather than failing.
  assert.equal(pickTarget(targets, "nope")?.title, "QuickAccess_uid2");
  assert.equal(pickTarget([]), null);
});

test("waitFor stops as soon as the condition holds", async () => {
  // Reply finishes on the third read: the shape of waiting for a stream to end.
  const fake = await startFakeCdp(["QuickAccess_uid2"], (_t, i) => i >= 2);
  try {
    const r = await waitFor<boolean>({ expression: "1", intervalMs: 100, cdpUrl: fake.base });
    assert.equal(r.satisfied, true);
    assert.equal(r.value, true);
    assert.equal(r.polls, 3);
  } finally {
    await fake.close();
  }
});

test("waitFor can match an exact value, not just truthiness", async () => {
  const fake = await startFakeCdp(["QuickAccess_uid2"], (_t, i) => (i >= 1 ? "done" : "streaming"));
  try {
    const r = await waitFor<string>({
      expression: "1",
      equals: "done",
      intervalMs: 100,
      cdpUrl: fake.base,
    });
    assert.equal(r.satisfied, true);
    assert.equal(r.value, "done");
  } finally {
    await fake.close();
  }
});

test("a timeout is a finding, not an error, and hands back the last value", async () => {
  const fake = await startFakeCdp(["QuickAccess_uid2"], () => "still streaming");
  try {
    const r = await waitFor<string>({
      expression: "1",
      equals: "done",
      waitMs: 300,
      intervalMs: 100,
      cdpUrl: fake.base,
    });
    assert.equal(r.satisfied, false);
    assert.equal(r.ok, true, "the read worked; the condition just never held");
    assert.equal(r.value, "still streaming", "how far it got is the useful part");
    assert.match(r.reason ?? "", /that is the finding, not an error/);
  } finally {
    await fake.close();
  }
});

// index.ts's deck_waitFor handler always builds the options object with an
// `equals` key present -- valued `undefined` when the caller did not ask for
// exact-match semantics -- because it reads:
//   equals: Object.prototype.hasOwnProperty.call(params, "equals") ? params.equals : undefined
// That is the shape every real call actually takes, and it is what exposed
// the bug: `waitFor` must treat "equals key present but undefined" the same
// as "no equals given at all," not as "equals: null".

test("waitFor keeps polling on null even when `equals` is explicitly undefined", async () => {
  // Real bug: this used to satisfy on the very first poll, because
  // JSON.stringify(null) === JSON.stringify(undefined ?? null).
  const fake = await startFakeCdp(["QuickAccess_uid2"], () => null);
  try {
    const r = await waitFor<unknown>({
      expression: "1",
      equals: undefined,
      waitMs: 300,
      intervalMs: 100,
      cdpUrl: fake.base,
    });
    assert.equal(r.satisfied, false);
    assert.equal(r.value, null);
  } finally {
    await fake.close();
  }
});

test("waitFor keeps polling on undefined and false even when `equals` is explicitly undefined", async () => {
  const fake = await startFakeCdp(["QuickAccess_uid2"], (_t, i) => (i === 0 ? undefined : false));
  try {
    const r = await waitFor<unknown>({
      expression: "1",
      equals: undefined,
      waitMs: 300,
      intervalMs: 100,
      cdpUrl: fake.base,
    });
    assert.equal(r.satisfied, false);
    assert.equal(r.value, false);
  } finally {
    await fake.close();
  }
});

test("waitFor is satisfied by a truthy object even when `equals` is explicitly undefined", async () => {
  // Real bug: this used to run to full timeout, because a populated object's
  // JSON never equals "null".
  const fake = await startFakeCdp(["QuickAccess_uid2"], (_t, i) =>
    i >= 2 ? { done: true, fences: 1 } : null,
  );
  try {
    const r = await waitFor<{ done: boolean; fences: number }>({
      expression: "1",
      equals: undefined,
      intervalMs: 100,
      cdpUrl: fake.base,
    });
    assert.equal(r.satisfied, true);
    assert.deepEqual(r.value, { done: true, fences: 1 });
    assert.equal(r.polls, 3);
  } finally {
    await fake.close();
  }
});

test("waitFor is satisfied by boolean true even when `equals` is explicitly undefined", async () => {
  // Real bug: same as above, but with "return only a boolean" -- which the
  // bug reports show is not a workaround either.
  const fake = await startFakeCdp(["QuickAccess_uid2"], (_t, i) => i >= 1);
  try {
    const r = await waitFor<boolean>({
      expression: "1",
      equals: undefined,
      intervalMs: 100,
      cdpUrl: fake.base,
    });
    assert.equal(r.satisfied, true);
    assert.equal(r.value, true);
  } finally {
    await fake.close();
  }
});

test("waitFor equals matches objects by JSON value, not just primitives", async () => {
  const fake = await startFakeCdp(["QuickAccess_uid2"], (_t, i) =>
    i >= 1 ? { done: true } : { done: false },
  );
  try {
    const r = await waitFor<{ done: boolean }>({
      expression: "1",
      equals: { done: true },
      intervalMs: 100,
      cdpUrl: fake.base,
    });
    assert.equal(r.satisfied, true);
    assert.deepEqual(r.value, { done: true });
  } finally {
    await fake.close();
  }
});

test("waitFor equals: null is a real target, distinct from equals being omitted", async () => {
  // Guards the fix itself: `opts.equals !== undefined` must still treat an
  // intentional `equals: null` as exact-match mode, not fall back to
  // truthiness (where the earlier "still going" string would already pass).
  const fake = await startFakeCdp(["QuickAccess_uid2"], (_t, i) => (i >= 1 ? null : "still going"));
  try {
    const r = await waitFor<unknown>({
      expression: "1",
      equals: null,
      intervalMs: 100,
      cdpUrl: fake.base,
    });
    assert.equal(r.satisfied, true);
    assert.equal(r.value, null);
    assert.equal(r.polls, 2);
  } finally {
    await fake.close();
  }
});

test("waitFor stops immediately when the read itself cannot run", async () => {
  // Polling a broken tunnel until the timeout just delays the same error.
  const r = await waitFor({
    expression: "1",
    cdpUrl: "http://127.0.0.1:1",
    waitMs: 5000,
    intervalMs: 100,
    timeoutMs: 800,
  });
  assert.equal(r.satisfied, false);
  assert.equal(r.ok, false);
  assert.equal(r.polls, 1, "one failed read is enough to know");
});

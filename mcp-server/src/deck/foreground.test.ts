/**
 * Tests for the Big Picture foreground check (GitHub issue #5): the reader,
 * deck_checkReady's `foreground` field, the press refusal in
 * acquireFocusIfUnowned, the deck_status member, and buildMatches on a
 * `local: true` machine.
 *
 * The CDP page is the shared fake (startFakeCdp); the page that never answers
 * is a bare http server that lists a Big Picture target and then ignores the
 * websocket upgrade. What none of this can model is in the honesty note of the
 * lane report: a real Steam's overlay pages, and window-manager focus.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { Socket } from "node:net";

process.env.DPS_NO_BRIDGE ??= "1";
const realHome = { USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME };
const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "dps-foreground-"));
process.env.USERPROFILE = tempHome;
process.env.HOME = tempHome;
const realDeckIp = process.env.DECK_IP;
delete process.env.DECK_IP;
after(() => {
  process.env.USERPROFILE = realHome.USERPROFILE;
  process.env.HOME = realHome.HOME;
  if (realDeckIp === undefined) delete process.env.DECK_IP;
  else process.env.DECK_IP = realDeckIp;
  fs.rmSync(tempHome, { recursive: true, force: true });
});

const { startFakeCdp, unfocusedPage } = await import("./__testutil__/fakeCdp.js");
const { readBigPictureForeground, bigPictureStatus } = await import("./foreground.js");
const { checkDeckReady } = await import("./checkReady.js");
const { acquireFocusIfUnowned } = await import("./walkTo.js");
const { readFocusAt } = await import("./readFocus.js");
const { verifyLocalInstalledBuild, localBuildManifest } = await import("./buildHash.js");
const { normalizeMachine, runWithMachine } = await import("../machines.js");
import type { PressResult } from "./pressButton.js";

const BPM = "Steam Big Picture Mode";
const hidden = { visibilityState: "hidden", hasFocus: false };
const visible = { visibilityState: "visible", hasFocus: true };

const windows = normalizeMachine("this-pc", { kind: "standin", os: "windows", local: true, press: "vigem" });
const steamos = normalizeMachine("deck", { kind: "deck", os: "steamos" });

const fakeFor = (bpm: unknown) =>
  startFakeCdp(["SharedJSContext", BPM], (title) => (title === BPM ? bpm : unfocusedPage));

/** A CDP endpoint that lists Big Picture and then never answers on its websocket. */
async function startSilentCdp(): Promise<{ base: string; close: () => Promise<void> }> {
  const sockets = new Set<Socket>();
  const server = http.createServer((req, res) => {
    const port = (server.address() as { port: number }).port;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify([
        { id: "T0", type: "page", title: BPM, url: "about:blank", webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/T0` },
      ]),
    );
  });
  server.on("upgrade", (_req, socket: Socket) => {
    sockets.add(socket); // never write the 101: the client waits until its timeout
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  return {
    base: `http://127.0.0.1:${port}`,
    close: async () => {
      for (const s of sockets) s.destroy();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

// --- the reader -------------------------------------------------------------

test("reader: a hidden, unfocused Big Picture page is foreground:false and says the numbers", async () => {
  const fake = await fakeFor(hidden);
  try {
    const r = await readBigPictureForeground(fake.base);
    assert.equal(r.foreground, false);
    assert.equal(r.visibilityState, "hidden");
    assert.equal(r.hasFocus, false);
    assert.match(r.reason, /Big Picture is not the foreground window \(visibilityState hidden, hasFocus false\)/);
  } finally {
    await fake.close();
  }
});

test("reader: visible but unfocused is still not foreground", async () => {
  const fake = await fakeFor({ visibilityState: "visible", hasFocus: false });
  try {
    assert.equal((await readBigPictureForeground(fake.base)).foreground, false);
  } finally {
    await fake.close();
  }
});

test("reader: visible and focused is foreground:true", async () => {
  const fake = await fakeFor(visible);
  try {
    assert.equal((await readBigPictureForeground(fake.base)).foreground, true);
  } finally {
    await fake.close();
  }
});

test("reader: no Big Picture page listed is unknown, never a pass", async () => {
  const fake = await startFakeCdp(["SharedJSContext"], () => unfocusedPage);
  try {
    const r = await readBigPictureForeground(fake.base);
    assert.equal(r.foreground, "unknown");
    assert.match(r.reason, /no "Steam Big Picture Mode" page is listed/);
  } finally {
    await fake.close();
  }
});

test("reader: a page that never answers is unknown after the budget", async () => {
  const silent = await startSilentCdp();
  try {
    const r = await readBigPictureForeground(silent.base, { timeoutMs: 300 });
    assert.equal(r.foreground, "unknown");
  } finally {
    await silent.close();
  }
});

test("reader: a nonsense reply is unknown, not a pass", async () => {
  const fake = await fakeFor({ unrelated: 1 });
  try {
    assert.equal((await readBigPictureForeground(fake.base)).foreground, "unknown");
  } finally {
    await fake.close();
  }
});

// --- deck_checkReady --------------------------------------------------------

test("checkReady on windows: hidden fails, naming the fact -- with nothing else declared", async () => {
  const fake = await fakeFor(hidden);
  try {
    const r = await runWithMachine(windows, () => checkDeckReady({}, { cdpUrl: fake.base }));
    assert.equal(r.ok, false);
    assert.deepEqual(r.failed, ["foreground"]);
    assert.match(r.checks.foreground.reason, /Big Picture is not the foreground window \(visibilityState hidden, hasFocus false\)/);
  } finally {
    await fake.close();
  }
});

test("checkReady on windows: visible and focused passes", async () => {
  const fake = await fakeFor(visible);
  try {
    const r = await runWithMachine(windows, () => checkDeckReady({}, { cdpUrl: fake.base }));
    assert.equal(r.ok, true);
    assert.equal(r.checks.foreground.verdict, "pass");
  } finally {
    await fake.close();
  }
});

test("checkReady on windows: an unreadable page is unknown, and unknown is not ready", async () => {
  const fake = await startFakeCdp(["SharedJSContext"], () => unfocusedPage);
  try {
    const r = await runWithMachine(windows, () => checkDeckReady({}, { cdpUrl: fake.base }));
    assert.equal(r.ok, false);
    assert.deepEqual(r.unknown, ["foreground"]);
  } finally {
    await fake.close();
  }
});

test("checkReady on windows: foreground:false opts out of the default", async () => {
  const fake = await fakeFor(hidden);
  try {
    const r = await runWithMachine(windows, () => checkDeckReady({ foreground: false }, { cdpUrl: fake.base }));
    assert.equal(r.ok, true, "declared it would be behind, and it is");
  } finally {
    await fake.close();
  }
});

test("checkReady on steamos: no foreground check unless it is asked for", async () => {
  const fake = await fakeFor(hidden);
  try {
    const none = await runWithMachine(steamos, () => checkDeckReady({}, { cdpUrl: fake.base }));
    assert.equal("foreground" in none.checks, false);
    assert.equal(fake.evaluations(), 0, "nothing was even read");
    const asked = await runWithMachine(steamos, () => checkDeckReady({ foreground: true }, { cdpUrl: fake.base }));
    assert.deepEqual(asked.failed, ["foreground"]);
  } finally {
    await fake.close();
  }
});

// --- acquireFocusIfUnowned --------------------------------------------------

async function unownedFocus() {
  const f = await startFakeCdp(["SharedJSContext"], () => unfocusedPage);
  try {
    const focus = await readFocusAt(f.base, 5000);
    assert.equal(focus.ok, false);
    assert.match(focus.reason ?? "", /gpfocus marker not found/);
    return focus;
  } finally {
    await f.close();
  }
}

function countingPress() {
  const calls: unknown[] = [];
  const press = (async (o: unknown) => {
    calls.push(o);
    return { ok: true } as PressResult;
  }) as never;
  return { calls, press };
}

test("acquire on windows: Big Picture hidden -- zero presses, and the reason is in the focus it returns", async () => {
  const fake = await fakeFor(hidden);
  try {
    const focus = await unownedFocus();
    const { calls, press } = countingPress();
    const out = await runWithMachine(windows, () =>
      acquireFocusIfUnowned(focus, { cdpBase: fake.base, direction: "DOWN", pressFn: press }),
    );
    assert.equal(calls.length, 0);
    assert.equal(out.presses, 0);
    assert.equal(out.acquired, false);
    assert.match(out.focus.reason ?? "", /gpfocus marker not found/);
    assert.match(out.focus.reason ?? "", /Big Picture is not the foreground window \(visibilityState hidden, hasFocus false\).*nothing was pressed/);
  } finally {
    await fake.close();
  }
});

test("acquire on windows: Big Picture unreadable -- zero presses, says it could not tell", async () => {
  const noPage = await startFakeCdp(["SharedJSContext"], () => unfocusedPage);
  try {
    const focus = await unownedFocus();
    const { calls, press } = countingPress();
    const out = await runWithMachine(windows, () =>
      acquireFocusIfUnowned(focus, { cdpBase: noPage.base, direction: "DOWN", pressFn: press }),
    );
    assert.equal(calls.length, 0);
    assert.match(out.focus.reason ?? "", /could not tell whether Big Picture is the foreground window/);
  } finally {
    await noPage.close();
  }
});

test("acquire on windows: Big Picture in front -- the old single press happens", async () => {
  const fake = await fakeFor(visible);
  try {
    const focus = await unownedFocus();
    const { calls, press } = countingPress();
    const out = await runWithMachine(windows, () =>
      acquireFocusIfUnowned(focus, { cdpBase: fake.base, direction: "DOWN", pressFn: press }),
    );
    assert.equal(calls.length, 1);
    assert.equal(out.acquired, true);
    assert.equal(out.presses, 1);
  } finally {
    await fake.close();
  }
});

test("acquire on steamos: no foreground read, the press goes as before", async () => {
  const fake = await fakeFor(hidden);
  try {
    const focus = await unownedFocus();
    const { calls, press } = countingPress();
    await runWithMachine(steamos, () =>
      acquireFocusIfUnowned(focus, { cdpBase: fake.base, direction: "DOWN", pressFn: press }),
    );
    assert.equal(calls.length, 1);
  } finally {
    await fake.close();
  }
});

// --- deck_status member -----------------------------------------------------

test("status member: bigPictureStatus reports the three fields; unreachable is unknown", async () => {
  const fake = await fakeFor(hidden);
  try {
    const s = await bigPictureStatus(async () => ({ base: fake.base, close: () => {} }));
    assert.deepEqual(
      { f: s.foreground, v: s.visibilityState, h: s.hasFocus },
      { f: false, v: "hidden", h: false },
    );
  } finally {
    await fake.close();
  }
  const dead = await bigPictureStatus(async () => {
    throw new Error("no debugger");
  });
  assert.equal(dead.foreground, "unknown");
  assert.match(dead.reason ?? "", /no debugger/);
});

// --- buildMatches on a local machine ---------------------------------------

function makePlugin(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dps-fg-plugin-"));
  fs.writeFileSync(path.join(root, "plugin.json"), JSON.stringify({ name: "bonsAI" }));
  fs.mkdirSync(path.join(root, "dist"));
  fs.writeFileSync(path.join(root, "dist", "index.js"), "// built\n");
  fs.writeFileSync(path.join(root, "main.py"), "# entry\n");
  return root;
}

function install(root: string, pluginsDir: string): string {
  const dest = path.join(pluginsDir, "bonsAI");
  fs.cpSync(root, dest, { recursive: true });
  return dest;
}

test("buildMatches on a local machine: a matching install passes with no host at all", async () => {
  const root = makePlugin();
  const pluginsDir = fs.mkdtempSync(path.join(os.tmpdir(), "dps-fg-plugins-"));
  install(root, pluginsDir);
  const m = normalizeMachine("this-pc", { kind: "standin", os: "windows", local: true, press: "vigem", pluginsDir });
  const r = await runWithMachine(m, () =>
    checkDeckReady({ buildMatches: true, foreground: false }, { pluginRoot: root, pluginName: "bonsAI" }),
  );
  assert.equal(r.checks.buildMatches.verdict, "pass", r.checks.buildMatches.reason);
  assert.equal(localBuildManifest(root).length, 3);
});

test("buildMatches on a local machine: a changed install fails, and __pycache__ does not count", async () => {
  const root = makePlugin();
  const pluginsDir = fs.mkdtempSync(path.join(os.tmpdir(), "dps-fg-plugins-"));
  const dest = install(root, pluginsDir);
  fs.mkdirSync(path.join(dest, "__pycache__"));
  fs.writeFileSync(path.join(dest, "__pycache__", "main.cpython-311.pyc"), "noise");
  assert.equal(verifyLocalInstalledBuild(root, "bonsAI", pluginsDir).matches, true);
  fs.writeFileSync(path.join(dest, "dist", "index.js"), "// stale\n");
  const m = normalizeMachine("this-pc", { kind: "standin", os: "windows", local: true, press: "vigem", pluginsDir });
  const r = await runWithMachine(m, () =>
    checkDeckReady({ buildMatches: true, foreground: false }, { pluginRoot: root, pluginName: "bonsAI" }),
  );
  assert.equal(r.checks.buildMatches.verdict, "fail");
  assert.match(r.checks.buildMatches.reason, /redeploy/);
});

test("buildMatches on a local machine: nothing installed is a confident fail", () => {
  const root = makePlugin();
  const pluginsDir = fs.mkdtempSync(path.join(os.tmpdir(), "dps-fg-plugins-"));
  const r = verifyLocalInstalledBuild(root, "bonsAI", pluginsDir);
  assert.equal(r.matches, false);
  assert.match(r.reason ?? "", /has not been deployed/);
});

// ---------------------------------------------------------------------------
// deck_focusBigPicture (focusBigPicture). The fake answers evaluates in order:
// gate read, IsWindowMinimized, the bring-to-front call, gate read again. The
// recipes themselves were measured on the maintainer's PC on 2026-10-25; what
// these prove is the control flow around them and that nothing is taken on
// trust: `ok` follows the second gate read, never the call's success.
// ---------------------------------------------------------------------------
const { focusBigPicture } = await import("./foreground.js");

const minimizedPage = { visibilityState: "hidden", hasFocus: false };
const behindPage = { visibilityState: "visible", hasFocus: false };

function scripted(answers: unknown[]) {
  return startFakeCdp(["SharedJSContext", BPM], (title, i) =>
    title === BPM ? answers[Math.min(i, answers.length - 1)] : unfocusedPage,
  );
}

test("focusBigPicture: already in front does nothing and says so", async () => {
  const fake = await startFakeCdp(["SharedJSContext", BPM], (title) => (title === BPM ? visible : unfocusedPage));
  try {
    let restored = 0;
    const r = await focusBigPicture(fake.base, { settleMs: 0, restoreWindow: () => void restored++ });
    assert.equal(r.ok, true);
    assert.deepEqual(r.steps, []);
    assert.equal(r.wasMinimized, false);
    assert.equal(restored, 0);
    assert.equal(fake.evaluations(), 1, "one gate read, nothing else");
    assert.match(r.reason, /already the foreground window/);
  } finally {
    await fake.close();
  }
});

test("focusBigPicture: behind another window -> Steam's call, no restore, ok from the second read", async () => {
  const fake = await scripted([behindPage, false, "ok", visible]);
  try {
    let restored = 0;
    const r = await focusBigPicture(fake.base, { settleMs: 0, restoreWindow: () => void restored++ });
    assert.equal(r.ok, true);
    assert.equal(r.wasMinimized, false);
    assert.equal(restored, 0, "not minimized, so no Win32 restore");
    assert.equal(r.steps.length, 1);
    assert.match(r.steps[0], /BringToFront\(1\)/);
    assert.equal(r.before.foreground, false);
    assert.equal(r.after?.foreground, true);
    assert.equal(fake.evaluations(), 4);
  } finally {
    await fake.close();
  }
});

test("focusBigPicture: minimized -> Win32 restore first, then Steam's call", async () => {
  const fake = await scripted([minimizedPage, true, "ok", visible]);
  try {
    const order: string[] = [];
    const r = await focusBigPicture(fake.base, {
      settleMs: 0,
      restoreWindow: () => {
        order.push("restore");
      },
    });
    assert.equal(r.ok, true);
    assert.equal(r.wasMinimized, true);
    assert.deepEqual(order, ["restore"]);
    assert.equal(r.steps.length, 2);
    assert.match(r.steps[0], /ShowWindow\(SW_RESTORE\)/);
    assert.match(r.steps[1], /BringToFront/);
  } finally {
    await fake.close();
  }
});

test("focusBigPicture: minimized and the restore throws -> ok false, the error named, gate re-read", async () => {
  const fake = await scripted([minimizedPage, true, minimizedPage]);
  try {
    const r = await focusBigPicture(fake.base, {
      settleMs: 0,
      restoreWindow: () => {
        throw new Error("powershell.exe exited 3");
      },
    });
    assert.equal(r.ok, false);
    assert.equal(r.wasMinimized, true);
    assert.match(r.reason, /Win32 restore failed: powershell.exe exited 3/);
    assert.equal(r.after?.foreground, false);
    assert.equal(fake.evaluations(), 3, "gate, minimized, gate again; the bring-to-front call is not made");
  } finally {
    await fake.close();
  }
});

test("focusBigPicture: minimized with no restore available -> refuses, does not call Steam", async () => {
  const fake = await scripted([minimizedPage, true]);
  try {
    const r = await focusBigPicture(fake.base, { settleMs: 0 });
    assert.equal(r.ok, false);
    assert.match(r.reason, /restore script was not available/);
    assert.equal(fake.evaluations(), 2);
  } finally {
    await fake.close();
  }
});

test("focusBigPicture: Steam's call 'succeeds' but the gate still reads behind -> ok false", async () => {
  const fake = await scripted([behindPage, false, "ok", behindPage]);
  try {
    const r = await focusBigPicture(fake.base, { settleMs: 0, restoreWindow: () => {} });
    assert.equal(r.ok, false);
    assert.match(r.reason, /still not in front/);
    assert.match(r.reason, /by hand/);
    assert.equal(r.after?.foreground, false);
  } finally {
    await fake.close();
  }
});

test("focusBigPicture: Steam's call throws -> recorded as a step, gate still decides", async () => {
  const fake = await scripted([behindPage, false, { __throw: "SteamClient is not defined" }, visible]);
  try {
    const r = await focusBigPicture(fake.base, { settleMs: 0, restoreWindow: () => {} });
    assert.equal(r.ok, true, "the gate read says in front, so ok -- whatever the call said");
    assert.match(r.steps[0], /bring-to-front call failed: .*SteamClient is not defined/);
  } finally {
    await fake.close();
  }
});

test("focusBigPicture: no Big Picture page -> ok false, unknown, nothing done", async () => {
  const fake = await startFakeCdp(["SharedJSContext"], () => unfocusedPage);
  try {
    let restored = 0;
    const r = await focusBigPicture(fake.base, { settleMs: 0, restoreWindow: () => void restored++ });
    assert.equal(r.ok, false);
    assert.equal(r.wasMinimized, "unknown");
    assert.equal(r.after, null);
    assert.equal(restored, 0);
    assert.equal(r.uiModeBefore, null, "SharedJSContext answered with no mode number");
    assert.equal(fake.evaluations(), 1, "one GetUIMode ask, no switch, no gate evaluate");
    assert.match(r.reason, /could not read whether Big Picture is in front/);
  } finally {
    await fake.close();
  }
});

// --- the UI-mode switch (desktop client -> Big Picture) -------------------
// The fake's target list is a function, so the Big Picture page can appear
// after SetUIMode is evaluated, the way Steam rebuilds its windows.

/** Per-title scripted answers, so SharedJSContext and Big Picture can be driven apart. */
function byTitle(script: Record<string, unknown[]>) {
  const counters: Record<string, number> = {};
  return (title: string) => {
    const answers = script[title] ?? [unfocusedPage];
    const i = counters[title] ?? 0;
    counters[title] = i + 1;
    return answers[Math.min(i, answers.length - 1)];
  };
}

test("focusBigPicture: no Big Picture page and UI mode 7 -> SetUIMode(4), wait for the page, then the usual recipe", async () => {
  let setModeCalled = false;
  const fake = await startFakeCdp(
    () => (setModeCalled ? ["SharedJSContext", BPM] : ["SharedJSContext"]),
    (title: string, _i: number) => {
      if (title === "SharedJSContext") {
        if (!setModeCalled) {
          // first evaluate: GetUIMode -> 7; second: SetUIMode -> flips the list
          const answer = sharedReads === 0 ? 7 : "ok";
          if (sharedReads === 1) setModeCalled = true;
          sharedReads++;
          return answer;
        }
        return "ok";
      }
      return bpmAnswers[Math.min(bpmReads++, bpmAnswers.length - 1)];
    },
  );
  let sharedReads = 0;
  let bpmReads = 0;
  const bpmAnswers = [behindPage, false, "ok", visible];
  try {
    const r = await focusBigPicture(fake.base, {
      settleMs: 0,
      modeSwitchWaitMs: 3000,
      modeSwitchPollMs: 20,
      restoreWindow: () => {},
    });
    assert.equal(r.ok, true, r.reason);
    assert.equal(r.uiModeBefore, 7);
    assert.ok(setModeCalled, "SetUIMode(4) was evaluated in SharedJSContext");
    assert.match(r.steps[0], /switched Steam from UI mode 7 \(desktop\) to Big Picture/);
    assert.match(r.steps[1], /BringToFront\(1\)/);
    assert.equal(r.after?.foreground, true);
  } finally {
    await fake.close();
  }
});

test("focusBigPicture: no Big Picture page but UI mode already 4 -> no switch, unknown as before", async () => {
  const fake = await startFakeCdp(["SharedJSContext"], byTitle({ SharedJSContext: [4] }));
  try {
    const r = await focusBigPicture(fake.base, { settleMs: 0, restoreWindow: () => {} });
    assert.equal(r.ok, false);
    assert.equal(r.uiModeBefore, 4);
    assert.deepEqual(r.steps, []);
    assert.equal(fake.evaluations(), 1, "GetUIMode only; SetUIMode is not sent when Steam says Big Picture");
    assert.match(r.reason, /could not read whether Big Picture is in front/);
  } finally {
    await fake.close();
  }
});

test("focusBigPicture: switched but the page never appears -> ok false, the wait named", async () => {
  const fake = await startFakeCdp(["SharedJSContext"], byTitle({ SharedJSContext: [7, "ok"] }));
  try {
    const r = await focusBigPicture(fake.base, {
      settleMs: 0,
      modeSwitchWaitMs: 60,
      modeSwitchPollMs: 10,
      restoreWindow: () => {},
    });
    assert.equal(r.ok, false);
    assert.equal(r.uiModeBefore, 7);
    assert.equal(r.steps.length, 1);
    assert.match(r.steps[0], /no Big Picture page appeared within 60 ms/);
    assert.equal(fake.evaluations(), 2, "GetUIMode and SetUIMode, nothing more");
  } finally {
    await fake.close();
  }
});

test("focusBigPicture: Big Picture page listed -> the UI mode is never asked", async () => {
  const fake = await startFakeCdp(["SharedJSContext", BPM], byTitle({ [BPM]: [visible] }));
  try {
    const r = await focusBigPicture(fake.base, { settleMs: 0, restoreWindow: () => {} });
    assert.equal(r.ok, true);
    assert.equal(r.uiModeBefore, null);
    assert.equal(fake.evaluations(), 1);
  } finally {
    await fake.close();
  }
});

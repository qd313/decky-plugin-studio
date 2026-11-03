/**
 * Tests for deck_probeDebugger (plan 12 lane A, item 2).
 *
 * The probe is a recorder, so what is tested is that it records what the fake
 * CEF does, in the words the result promises: each connect's outcome, when the
 * Quick Access page first answered, when Decky's tab was first mounted, how
 * many resets it saw, and a timeline that collapses runs of the same state.
 *
 * fakeCdp.ts's restart() is a guess at what CEF does after a plugin_loader
 * restart. These tests prove the probe tells reset, hang-up and empty apart;
 * the real sequence is what the probe is for, and has not been recorded yet.
 */
process.env.DPS_NO_BRIDGE ??= "1";

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { startFakeCdp, unfocusedPage } from "./__testutil__/fakeCdp.js";
import { sandboxHome } from "./__testutil__/sandboxHome.js";
import { classifyCdpFailure, compactTimeline, sampleDebugger, summarizeSamples, type ProbeSample } from "./probeDebugger.js";
import { clearLoaderRestart, noteLoaderRestart } from "./loaderRestart.js";
import { QUICK_ACCESS_PROBE_EXPRESSION } from "./readFocus.js";
import { probeDebugger, probeSeconds } from "../tools/deckAutonomy.js";
import { currentMachine } from "../machines.js";

sandboxHome("dps-probe-");

const TARGETS = ["SharedJSContext", "Steam Big Picture Mode", "QuickAccess_uid2"];

/** The Quick Access page answers the rail read; Decky's pane is mounted from `deckyAt` (epoch ms). */
function page(deckyAt = 0) {
  return (title: string, _i: number, expr: string): unknown => {
    if (expr === "1+1") return 2;
    if (expr === QUICK_ACCESS_PROBE_EXPRESSION && title === "QuickAccess_uid2") {
      return { visiblePane: "3", ownsFocus: true, paneCount: 5, deckyPaneMounted: Date.now() >= deckyAt, visibilityState: "visible" };
    }
    return unfocusedPage;
  };
}

const FAST = { intervalMs: 40, opTimeoutMs: 800 };

test("classifyCdpFailure names each shape from the error's own words", () => {
  assert.equal(classifyCdpFailure("read ECONNRESET"), "ECONNRESET");
  assert.equal(classifyCdpFailure("connection closed before a reply: socket error: read ECONNRESET"), "ECONNRESET");
  assert.equal(classifyCdpFailure("socket hang up"), "socket hang up");
  assert.equal(classifyCdpFailure("socket hang up: closed before the websocket handshake answered"), "socket hang up");
  assert.equal(classifyCdpFailure("connect ECONNREFUSED 127.0.0.1:8080"), "ECONNREFUSED");
  assert.equal(classifyCdpFailure("GET http://x/json/list timed out after 1500ms"), "timeout");
  assert.equal(classifyCdpFailure("websocket handshake timed out after 1500ms"), "timeout");
  assert.equal(classifyCdpFailure("Runtime.evaluate timed out after 1500ms"), "timeout");
  assert.equal(classifyCdpFailure("GET http://x/json/list returned HTTP 500"), "http-error");
  assert.equal(classifyCdpFailure("websocket upgrade refused: HTTP/1.1 404 Not Found"), "http-error");
  assert.equal(classifyCdpFailure("connection closed before a reply: closed"), "closed");
  assert.equal(classifyCdpFailure("something else"), "error");
});

test("a healthy debugger: every sample ok, readable at once, one state in the timeline", async () => {
  const fake = await startFakeCdp(TARGETS, page());
  try {
    const { summary, samples } = await sampleDebugger({ cdpBase: fake.base, seconds: 1, restartMachine: "probe-healthy", ...FAST });
    assert.equal(summary.zero, "probe-start");
    assert.ok(samples.length >= 5, `${samples.length} samples`);
    assert.equal(summary.resetsSeen, 0);
    assert.ok((summary.firstReadableQuickAccessMs ?? 99) < 100);
    assert.equal(summary.quickAccessStableFromMs, summary.firstReadableQuickAccessMs);
    assert.ok((summary.firstDeckyTabMs ?? 99) < 100);
    assert.equal(summary.timeline.length, 1);
    assert.deepEqual(summary.timeline[0].targets, TARGETS);
    const s = samples[0];
    assert.deepEqual(s.list.targets?.map((t) => t.title), TARGETS);
    assert.equal(s.sharedJs?.outcome, "ok");
    assert.equal(s.sharedJs?.target, "SharedJSContext");
    assert.equal(s.quickAccess?.outcome, "ok");
    assert.equal(s.quickAccess?.visiblePane, "3");
    assert.equal(s.deckyTab, true);
    assert.equal(s.sinceRestartMs, null);
  } finally {
    await fake.close();
  }
});

for (const [mode, expected] of [
  ["reset", /ECONNRESET|socket hang up/],
  ["hangup", /socket hang up/],
] as const) {
  test(`after a restart that answers "${mode}" for 600 ms: resets counted, times measured from the restart note, then readable`, async () => {
    const fake = await startFakeCdp(TARGETS, page());
    const machine = `probe-${mode}`;
    try {
      noteLoaderRestart(machine);
      fake.restart(600, mode);
      const { summary, samples } = await sampleDebugger({ cdpBase: fake.base, seconds: 1.5, restartMachine: machine, ...FAST });
      assert.equal(summary.zero, "restart-note");
      assert.ok(summary.resetsSeen > 0, "resets recorded");
      assert.match(samples[0].list.outcome, expected);
      assert.ok(samples.every((s) => s.list.outcome !== "timeout"), "a hang-up is a hang-up, not a handshake timeout");
      assert.ok(summary.firstReadableQuickAccessMs !== null && summary.firstReadableQuickAccessMs >= 550, `${summary.firstReadableQuickAccessMs}`);
      assert.ok(summary.lastResetMs !== null && summary.lastResetMs < summary.firstReadableQuickAccessMs!);
      assert.equal(summary.quickAccessStableFromMs, summary.firstReadableQuickAccessMs);
      assert.ok(summary.timeline.length >= 2);
      assert.equal(summary.timeline.at(-1)?.quickAccess, "ok");
      assert.ok(samples.every((s) => s.sinceRestartMs !== null && s.sinceRestartMs >= s.t - 5));
    } finally {
      clearLoaderRestart(machine);
      await fake.close();
    }
  });
}

test("an empty target list: the list answers, both pages are not-listed, and that is not counted as a reset", async () => {
  const fake = await startFakeCdp(TARGETS, page());
  try {
    fake.restart(400, "empty");
    const { summary, samples } = await sampleDebugger({ cdpBase: fake.base, seconds: 1, restartMachine: "probe-empty", ...FAST });
    assert.equal(samples[0].list.outcome, "ok");
    assert.deepEqual(samples[0].list.targets, []);
    assert.equal(samples[0].sharedJs?.outcome, "not-listed");
    assert.equal(samples[0].quickAccess?.outcome, "not-listed");
    assert.equal(samples[0].deckyTab, null);
    assert.equal(summary.resetsSeen, 0);
    assert.ok((summary.firstReadableQuickAccessMs ?? 0) >= 350);
  } finally {
    await fake.close();
  }
});

test("Decky's tab mounted late: firstDeckyTabMs is when it was first seen, not when the page first answered", async () => {
  const fake = await startFakeCdp(TARGETS, page(Date.now() + 500));
  try {
    const { summary } = await sampleDebugger({ cdpBase: fake.base, seconds: 1, restartMachine: "probe-late-tab", ...FAST });
    assert.ok((summary.firstReadableQuickAccessMs ?? 99) < 100);
    assert.ok(summary.firstDeckyTabMs !== null && summary.firstDeckyTabMs >= 450, `${summary.firstDeckyTabMs}`);
    assert.deepEqual(
      summary.timeline.map((s) => s.deckyTab),
      [false, true],
    );
  } finally {
    await fake.close();
  }
});

test("quickAccessStableFromMs is the start of the last unbroken run of answers; a flap after the first answer moves it", () => {
  const s = (t: number, qa: ProbeSample["quickAccess"]): ProbeSample => ({
    t,
    sinceRestartMs: t,
    list: { outcome: "ok", ms: 1, targets: [] },
    sharedJs: { target: "SharedJSContext", outcome: "ok", ms: 1 },
    quickAccess: qa,
    deckyTab: qa?.outcome === "ok" ? true : null,
  });
  const ok = { target: "QuickAccess_uid2", outcome: "ok" as const, ms: 1 };
  const reset = { target: "QuickAccess_uid2", outcome: "ECONNRESET" as const, ms: 1 };
  const samples = [s(0, reset), s(250, ok), s(500, reset), s(750, ok), s(1000, ok)];
  const sum = summarizeSamples(samples);
  assert.equal(sum.firstReadableQuickAccessMs, 250);
  assert.equal(sum.quickAccessStableFromMs, 750);
  assert.equal(sum.resetsSeen, 2);
  assert.equal(sum.lastResetMs, 500);
  assert.deepEqual(sum.outcomes.quickAccess, { ECONNRESET: 2, ok: 3 });
  assert.equal(compactTimeline(samples).length, 4);
});

test("the tool with afterReload: reloads first through the reload code, samples from the note, writes the run file", async () => {
  const fake = await startFakeCdp(TARGETS, page());
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "dps-probe-ws-"));
  const savedWs = process.env.DECKY_STUDIO_WORKSPACE;
  process.env.DECKY_STUDIO_WORKSPACE = workspace;
  const calls: string[] = [];
  try {
    const r = await probeDebugger({
      cdpUrl: fake.base,
      afterReload: true,
      seconds: 1,
      ...FAST,
      reload: async (mode, o) => {
        calls.push(`${mode}:${o?.waitForLoader}`);
        fake.restart(300, "reset");
        noteLoaderRestart(currentMachine().name, Date.now(), "deck_reloadPlugin");
        return { ok: true, mode: "remote", method: "fake restart", loader: null };
      },
    });
    assert.deepEqual(calls, ["auto:false"], "the reload ran once, with no loader wait");
    assert.equal(r.ok, true);
    assert.equal(r.afterReload, true);
    assert.equal(r.reload?.method, "fake restart");
    assert.equal(r.zero, "restart-note");
    assert.equal(r.restartNote?.source, "deck_reloadPlugin");
    assert.ok(r.resetsSeen > 0);
    assert.match(r.summary, /^restarted plugin_loader \(fake restart, \d+ ms\), then \d+ samples over 1 s/);
    assert.ok(r.file && r.file.startsWith(path.join(workspace, "runs")), `${r.file}`);
    assert.match(path.basename(r.file!), /^probe-debugger_\d{8}_\d{6}\.json$/);
    const saved = JSON.parse(fs.readFileSync(r.file!, "utf8"));
    assert.equal(saved.tool, "deck_probeDebugger");
    assert.equal(saved.sampleList.length, r.samples);
    assert.equal(saved.machine.name, currentMachine().name);
  } finally {
    clearLoaderRestart(currentMachine().name);
    if (savedWs === undefined) delete process.env.DECKY_STUDIO_WORKSPACE;
    else process.env.DECKY_STUDIO_WORKSPACE = savedWs;
    fs.rmSync(workspace, { recursive: true, force: true });
    await fake.close();
  }
});

test("the tool without afterReload never calls the reload; a failed reload samples nothing and says so", async () => {
  const fake = await startFakeCdp(TARGETS, page());
  try {
    let reloads = 0;
    const plain = await probeDebugger({
      cdpUrl: fake.base,
      seconds: 1,
      ...FAST,
      writeEvidence: false,
      reload: async () => {
        reloads++;
        return { ok: true, mode: "remote", method: "x" };
      },
    });
    assert.equal(reloads, 0);
    assert.equal(plain.reload, null);
    assert.equal(plain.file, null);
    const failed = await probeDebugger({
      cdpUrl: fake.base,
      afterReload: true,
      seconds: 1,
      ...FAST,
      writeEvidence: false,
      reload: async () => {
        throw new Error("DECK_IP not configured");
      },
    });
    assert.equal(failed.ok, false);
    assert.equal(failed.samples, 0);
    assert.match(failed.reason ?? "", /the reload failed, so there was no restart to measure: DECK_IP not configured/);
  } finally {
    await fake.close();
  }
});

test("seconds: default 30, clamped to 1..300, and to 55 without afterReload (the 60 s read deadline)", () => {
  assert.deepEqual(probeSeconds(undefined, false), { requested: 30, seconds: 30 });
  assert.deepEqual(probeSeconds(120, false), { requested: 120, seconds: 55 });
  assert.deepEqual(probeSeconds(120, true), { requested: 120, seconds: 120 });
  assert.deepEqual(probeSeconds(9999, true), { requested: 300, seconds: 300 });
  assert.deepEqual(probeSeconds(-4, true), { requested: 30, seconds: 30 });
  assert.deepEqual(probeSeconds("abc", true), { requested: 30, seconds: 30 });
});

test("the dispatch seam drives (lease, queue, driving deadline) only when afterReload is true", () => {
  // index.ts cannot be imported without starting the server; this pins the one
  // line that makes afterReload a driving call, so a merge cannot drop it quietly.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const src = fs.readFileSync(path.join(here, "..", "index.ts"), "utf8");
  assert.match(src, /tool === "deck_probeDebugger" && args\.afterReload === true/);
  assert.match(src, /const driving = drivesThisCall\(tool, rest\)/);
  assert.match(src, /const cls = callClassOf\(tool, params\)/);
  assert.doesNotMatch(src, /"deck_probeDebugger",\s*\n/, "it is not in DRIVING_TOOLS unconditionally");
});

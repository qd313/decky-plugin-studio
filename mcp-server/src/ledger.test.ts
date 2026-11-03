/**
 * Tests for the run ledger (ledger.ts) and the file-naming rules it shares with
 * the evidence tools (evidenceName.ts).
 *
 * What these can show: line shapes, that a failing ledger never changes a
 * call's outcome, that the cached build/game read is stamped, aged out and
 * cleared as written, that `saveAs` cannot leave its folder. What they cannot:
 * that a real MCP client's call reaches this seam (the source check at the end
 * pins the wiring, a PC call is what proves it).
 */
process.env.DPS_NO_BRIDGE ??= "1";

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  Ledger,
  LedgerLine,
  MachineStamp,
  STATE_MAX_AGE_MS,
  ledgerDir,
  readLedger,
  recordAtSeam,
  sessionId,
  summariseResult,
} from "./ledger.js";
import {
  attachNamedEvidence,
  cleanRowId,
  evidencePath,
  sanitizeEvidenceName,
  saveAsFileName,
  withExtension,
} from "./evidenceName.js";
import { TOOLS } from "./toolRegistry.js";

function tmp(label: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `dps-ledger-${label}-`));
}

const PC: MachineStamp = { name: "this-pc", kind: "standin", os: "windows" };
const DECK: MachineStamp = { name: "deck", kind: "deck", os: "steamos" };

function makeLedger(dir: string, over: { now?: () => number; log?: (l: string) => void } = {}): Ledger {
  let clock = Date.parse("2026-11-02T12:00:00Z");
  return new Ledger({
    dir: () => dir,
    now: over.now ?? (() => (clock += 10)),
    pid: 4242,
    startedAt: Date.parse("2026-11-02T11:59:00Z"),
    log: over.log ?? (() => {}),
  });
}

function lines(l: Ledger): LedgerLine[] {
  return fs
    .readFileSync(l.file(), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((x) => JSON.parse(x) as LedgerLine);
}

const spec = (tool: string, over: Partial<{ args: Record<string, unknown>; rowId: string; machine: MachineStamp | null }> = {}) => ({
  tool,
  args: over.args ?? {},
  rowId: over.rowId,
  machineOf: () => (over.machine === undefined ? DECK : over.machine),
});

// ---------------------------------------------------------------------------
// Session and folder
// ---------------------------------------------------------------------------

test("a session id is the server start time in UTC plus the pid, and is safe in a file name", () => {
  assert.equal(sessionId(Date.parse("2026-11-02T15:30:12Z"), 4242), "20261102T153012Z_pid4242");
  assert.match(sessionId(Date.now(), 1), /^[0-9]{8}T[0-9]{6}Z_pid[0-9]+$/);
});

test("the ledger lives in runs/ledger under the workspace", () => {
  assert.equal(ledgerDir(path.join("w", "x")), path.join("w", "x", "runs", "ledger"));
});

// ---------------------------------------------------------------------------
// One line per call
// ---------------------------------------------------------------------------

test("a call that returns writes one line with the fields the result carries", async () => {
  const dir = tmp("one");
  const l = makeLedger(dir);
  const result = {
    ok: true,
    presses: 7,
    fidelity: "wire-sent",
    evidenceFile: "C:\\ws\\runs\\walk.json",
    machine: PC,
  };
  const returned = await l.record(spec("deck_walkTo", { rowId: "ROW-1", machine: null }), async () => result);
  assert.equal(returned, result, "the result is returned untouched");

  const [line] = lines(l);
  assert.equal(line.tool, "deck_walkTo");
  assert.equal(line.session, "20261102T115900Z_pid4242");
  assert.deepEqual(line.machine, PC, "the machine comes from the result's own stamp");
  assert.equal(line.ok, true);
  assert.equal(line.presses, 7);
  assert.equal(line.fidelity, "wire-sent");
  assert.equal(line.evidenceFile, "C:\\ws\\runs\\walk.json");
  assert.equal(line.rowId, "ROW-1");
  assert.equal(typeof line.durationMs, "number");
  assert.match(line.ts, /^2026-11-02T12:00:00\.\d{3}Z$/);
  assert.equal("error" in line, false);
  assert.equal("buildHash" in line, false, "nothing recent knew the build, so the line does not say");
  assert.equal(path.basename(l.file()), "20261102T115900Z_pid4242.ndjson");
});

test("a result that says ok: false is a failed line with the first line of its reason", async () => {
  const l = makeLedger(tmp("refuse"));
  await l.record(spec("deck_launchGame"), async () => ({ ok: false, reason: "Play button read Install\nsecond line", presses: 2, fidelity: null }));
  const [line] = lines(l);
  assert.equal(line.ok, false);
  assert.equal(line.error, "Play button read Install");
  assert.equal(line.presses, 2);
  assert.equal(line.fidelity, null, "null fidelity is kept: it means no press was sent");
});

test("a ok:false result with no reason falls back to its summary, then to a plain sentence", async () => {
  const l = makeLedger(tmp("summary"));
  await l.record(spec("deck_a"), async () => ({ ok: false, summary: "refused: nothing identified the game" }));
  await l.record(spec("deck_b"), async () => ({ ok: false }));
  const [a, b] = lines(l);
  assert.equal(a.error, "refused: nothing identified the game");
  assert.match(b.error ?? "", /gave no reason/);
});

test("a thrown error is logged and rethrown as the same object", async () => {
  const l = makeLedger(tmp("throw"));
  const boom = new Error("tunnel refused\nstack-ish second line");
  await assert.rejects(
    () => l.record(spec("deck_readFocus", { machine: PC }), async () => {
      throw boom;
    }),
    (e) => e === boom,
  );
  const [line] = lines(l);
  assert.equal(line.ok, false);
  assert.equal(line.error, "tunnel refused");
  assert.deepEqual(line.machine, PC);
  assert.equal("deadline" in line, false);
});

test("a deadline expiry is marked, and a long error is cut", async () => {
  const l = makeLedger(tmp("deadline"));
  const err = new Error("deck_walkTo did not finish within its deadline of 300 ms. " + "x".repeat(600));
  err.name = "CallDeadlineError";
  await assert.rejects(() => l.record(spec("deck_walkTo"), async () => Promise.reject(err)));
  const [line] = lines(l);
  assert.equal(line.deadline, true);
  assert.ok((line.error ?? "").length <= 300);
  assert.match(line.error ?? "", /^deck_walkTo did not finish within its deadline of 300 ms/);
});

test("a killswitch stop is marked on the line", async () => {
  const l = makeLedger(tmp("stopped"));
  await l.record(spec("deck_sweep"), async () => ({ ok: false, stopped: true, reason: "KILLSWITCH", totals: { presses: 3 } }));
  const [line] = lines(l);
  assert.equal(line.stopped, true);
  assert.equal(line.presses, 3, "a sweep's count lives in totals");
});

test("concurrent calls each get exactly one whole line", async () => {
  const l = makeLedger(tmp("concurrent"));
  await Promise.all(
    Array.from({ length: 12 }, (_, i) =>
      l.record(spec(`deck_t${i}`), async () => {
        await new Promise((r) => setTimeout(r, 12 - i));
        return { ok: true };
      }),
    ),
  );
  const got = lines(l);
  assert.equal(got.length, 12);
  assert.equal(new Set(got.map((x) => x.tool)).size, 12);
});

test("deck_runReport, deck_status and deck_automationStatus are not recorded", async () => {
  const dir = path.join(tmp("skip"), "ledger");
  const l = makeLedger(dir);
  for (const t of ["deck_runReport", "deck_status", "deck_automationStatus"]) {
    const r = await l.record(spec(t), async () => ({ ok: true }));
    assert.deepEqual(r, { ok: true });
  }
  assert.equal(fs.existsSync(dir), false, "nothing was written, not even the folder");
});

// ---------------------------------------------------------------------------
// What a result's fields turn into
// ---------------------------------------------------------------------------

test("presses come from the count a result carries, else its stages, else one for a single press", () => {
  assert.equal(summariseResult("deck_walkTo", { presses: 4 }).presses, 4);
  assert.equal(summariseResult("deck_sweep", { totals: { presses: 9 } }).presses, 9);
  assert.equal(
    summariseResult("deck_openPlugin", { stages: [{ presses: 1 }, { presses: 0 }, { presses: 3 }] }).presses,
    4,
  );
  assert.equal(summariseResult("deck_pressButton", { fidelity: "wire-sent" }).presses, 1);
  assert.equal(summariseResult("deck_pressButton", { fidelity: null }).presses, 0);
  assert.equal(summariseResult("deck_assertFocusMove", { fidelity: "steam-routed" }).presses, 1);
  assert.equal("presses" in summariseResult("deck_readFocus", { ok: true }), false, "a read has no count; none is invented");
  assert.equal("presses" in summariseResult("deck_runSequence", { steps: [], ranSteps: 5 }), false);
});

test("a screenshot's or a recording's path is its evidence file", () => {
  assert.equal(summariseResult("deck_captureScreenshot", { path: "C:\\ws\\screenshots\\a.png" }).evidenceFile, "C:\\ws\\screenshots\\a.png");
  assert.equal(summariseResult("deck_record", { path: "/ws/recordings/a.mkv" }).evidenceFile, "/ws/recordings/a.mkv");
  assert.equal("evidenceFile" in summariseResult("deck_readFocus", { path: "x" }), false);
  assert.deepEqual(summariseResult("deck_x", "not an object"), {});
  assert.deepEqual(summariseResult("deck_x", null), {});
});

// ---------------------------------------------------------------------------
// Writing can never fail a call
// ---------------------------------------------------------------------------

test("a ledger folder that cannot be written changes nothing about the call and is logged once", async () => {
  const root = tmp("broken");
  const blocker = path.join(root, "ledger-is-a-file");
  fs.writeFileSync(blocker, "x");
  const logged: string[] = [];
  const l = makeLedger(path.join(blocker, "sub"), { log: (x) => logged.push(x) });

  const r1 = await l.record(spec("deck_a"), async () => ({ ok: true, v: 1 }));
  const r2 = await l.record(spec("deck_b"), async () => ({ ok: true, v: 2 }));
  assert.deepEqual(r1, { ok: true, v: 1 });
  assert.deepEqual(r2, { ok: true, v: 2 });
  await assert.rejects(
    () => l.record(spec("deck_c"), async () => Promise.reject(new Error("the tool's own error"))),
    /the tool's own error/,
  );

  assert.equal(logged.length, 1, "one stderr line, then quiet");
  assert.match(logged[0], /ledger: could not write a line/);
  const st = l.status();
  assert.equal(st.appended, 0);
  assert.ok(st.lastError, "the doctor can read why");
});

test("a machine lookup, a logger or a result that throws cannot change the outcome", async () => {
  const dir = tmp("hostile");
  const l = new Ledger({
    dir: () => dir,
    log: () => {
      throw new Error("logging failed too");
    },
  });
  const bad = { machineOf: () => { throw new Error("no such machine"); }, tool: "deck_x", args: {} };
  assert.deepEqual(await l.record(bad, async () => ({ ok: true })), { ok: true });
  await assert.rejects(() => l.record(bad, async () => Promise.reject(new Error("tool failed"))), /tool failed/);

  const evil = {
    get presses(): number {
      throw new Error("getter blew up");
    },
  };
  assert.equal(await l.record(spec("deck_y"), async () => evil), evil);
});

test("a write that works again clears the last error", async () => {
  const root = tmp("recover");
  const dir = path.join(root, "ledger");
  fs.writeFileSync(dir, "a file where the folder should be");
  const l = makeLedger(dir);
  await l.record(spec("deck_a"), async () => ({ ok: true }));
  assert.ok(l.status().lastError);
  fs.rmSync(dir);
  await l.record(spec("deck_b"), async () => ({ ok: true }));
  assert.equal(l.status().lastError, null);
  assert.equal(l.status().appended, 1);
});

// ---------------------------------------------------------------------------
// The last build / game read, never a new one
// ---------------------------------------------------------------------------

const readyWithBuild = (matches: boolean, hash: string | null, verdict = "pass") => ({
  ok: matches,
  checks: { buildMatches: { declared: true, actual: matches, verdict, reason: "", localHash: hash } },
});

test("a later line carries the build the last checkReady found, with when it was read", async () => {
  const l = makeLedger(tmp("build"));
  await l.record(spec("deck_checkReady", { machine: DECK }), async () => readyWithBuild(true, "a".repeat(64)));
  await l.record(spec("deck_walkTo", { machine: DECK }), async () => ({ ok: true }));
  const [ready, walk] = lines(l);
  assert.equal(ready.buildHash, "a".repeat(64), "the read itself is stamped");
  assert.equal(walk.buildHash, "a".repeat(64));
  assert.equal(walk.buildMatches, true);
  assert.match(walk.stateReadAt ?? "", /^2026-11-02T12:00:00/);
});

test("the build belongs to one machine; another machine's line does not get it", async () => {
  const l = makeLedger(tmp("permachine"));
  await l.record(spec("deck_checkReady", { machine: DECK }), async () => readyWithBuild(true, "b".repeat(64)));
  await l.record(spec("deck_readFocus", { machine: PC }), async () => ({ ok: true }));
  assert.equal("buildHash" in lines(l)[1], false);
});

test("a build that did not match is recorded as differing, with no hash to file as the Deck's", async () => {
  const l = makeLedger(tmp("stale"));
  await l.record(spec("deck_checkReady"), async () => readyWithBuild(false, "c".repeat(64)));
  await l.record(spec("deck_walkTo"), async () => ({ ok: true }));
  const walk = lines(l)[1];
  assert.equal(walk.buildMatches, false);
  assert.equal("buildHash" in walk, false);
});

test("an unknown build verdict teaches nothing", async () => {
  const l = makeLedger(tmp("unknown"));
  await l.record(spec("deck_checkReady"), async () => readyWithBuild(true, null, "unknown"));
  await l.record(spec("deck_walkTo"), async () => ({ ok: true }));
  assert.equal("buildMatches" in lines(l)[1], false);
});

test("deck_deploy forgets the build, because what is installed just changed", async () => {
  const l = makeLedger(tmp("deploy"));
  await l.record(spec("deck_checkReady"), async () => readyWithBuild(true, "d".repeat(64)));
  await l.record(spec("deck_deploy"), async () => ({ ok: true }));
  await l.record(spec("deck_walkTo"), async () => ({ ok: true }));
  const [, deploy, walk] = lines(l);
  assert.equal("buildHash" in deploy, false);
  assert.equal("buildHash" in walk, false);
});

test("a build read older than the age limit is not put on a line", async () => {
  let t = Date.parse("2026-11-02T12:00:00Z");
  const l = makeLedger(tmp("age"), { now: () => t });
  await l.record(spec("deck_checkReady"), async () => readyWithBuild(true, "e".repeat(64)));
  t += STATE_MAX_AGE_MS - 1000;
  await l.record(spec("deck_walkTo"), async () => ({ ok: true }));
  t += 2000;
  await l.record(spec("deck_walkTo"), async () => ({ ok: true }));
  const [, young, old] = lines(l);
  assert.equal(young.buildHash, "e".repeat(64));
  assert.equal("buildHash" in old, false);
  assert.equal("stateReadAt" in old, false);
});

test("the running game: listGames and checkReady teach it; empty is null, unread is absent", async () => {
  const l = makeLedger(tmp("game"));
  await l.record(spec("deck_readFocus"), async () => ({ ok: true }));
  await l.record(spec("deck_listGames"), async () => ({ ok: true, running: [{ appid: 220, name: "Half-Life 2" }] }));
  await l.record(spec("deck_readFocus"), async () => ({ ok: true }));
  await l.record(spec("deck_listGames"), async () => ({ ok: true, running: [] }));
  await l.record(spec("deck_readFocus"), async () => ({ ok: true }));
  await l.record(spec("deck_listGames"), async () => ({ ok: true, running: null }));
  await l.record(spec("deck_readFocus"), async () => ({ ok: true }));
  const got = lines(l);
  assert.equal("runningGame" in got[0], false, "no read yet: absent, not null");
  assert.deepEqual(got[2].runningGame, { appid: 220, name: "Half-Life 2" });
  assert.equal(got[4].runningGame, null, "a read that saw nothing running");
  assert.equal(got[6].runningGame, null, "an unreadable list changes nothing, so the last answer stands");
});

test("launch and exit that RunningApps confirmed update the game; a refused one does not", async () => {
  const l = makeLedger(tmp("launch"));
  await l.record(spec("deck_launchGame"), async () => ({ ok: false, running: null, reason: "no" }));
  await l.record(spec("deck_readFocus"), async () => ({ ok: true }));
  await l.record(spec("deck_launchGame"), async () => ({ ok: true, running: { appid: 1794680, name: "Vampire Survivors" } }));
  await l.record(spec("deck_exitGame"), async () => ({ ok: true, running: null }));
  const got = lines(l);
  assert.equal("runningGame" in got[1], false);
  assert.deepEqual(got[2].runningGame, { appid: 1794680, name: "Vampire Survivors" });
  assert.equal(got[3].runningGame, null);
});

test("checkReady's running app ids keep a name a listGames gave for the same app", async () => {
  const l = makeLedger(tmp("ids"));
  await l.record(spec("deck_listGames"), async () => ({ ok: true, running: [{ appid: 220, name: "Half-Life 2" }] }));
  await l.record(spec("deck_checkReady"), async () => ({ ok: true, checks: { runningAppId: { verdict: "pass", actual: [220] } } }));
  await l.record(spec("deck_checkReady"), async () => ({ ok: true, checks: { runningAppId: { verdict: "pass", actual: [999] } } }));
  const got = lines(l);
  assert.deepEqual(got[1].runningGame, { appid: 220, name: "Half-Life 2" });
  assert.deepEqual(got[2].runningGame, { appid: 999, name: null });
});

// ---------------------------------------------------------------------------
// The seam's side
// ---------------------------------------------------------------------------

const cfg = {
  rowIdTools: new Set(["deck_walkTo"]),
  registryTools: new Set(["deck_stopAutomation", "deck_runReport"]),
  stampOf: (a: Record<string, unknown>): MachineStamp | null => (a.machine === "nope" ? null : a.machine === "this-pc" ? PC : DECK),
};

test("the seam gives rowId to evidence tools and withholds it from every other tool, but records it for all", async () => {
  const l = makeLedger(tmp("seam"));
  const seen: Record<string, unknown>[] = [];
  const run = async (args: Record<string, unknown>) => {
    seen.push(args);
    return { ok: true };
  };
  await recordAtSeam(l, cfg, "deck_walkTo", { rowId: "R1", text: "x" }, run);
  await recordAtSeam(l, cfg, "deck_configure", { rowId: "R2", DECK_IP: "1.2.3.4" }, run);
  assert.deepEqual(seen[0], { rowId: "R1", text: "x" });
  assert.deepEqual(seen[1], { DECK_IP: "1.2.3.4" }, "deck_configure never sees rowId; it would be written into deck.env");
  const got = lines(l);
  assert.equal(got[0].rowId, "R1");
  assert.equal(got[1].rowId, "R2");
});

test("only deck_ and plugin_ calls are recorded", async () => {
  const l = makeLedger(tmp("prefix"));
  const run = async () => ({ ok: true });
  await recordAtSeam(l, cfg, "studio_doctor", {}, run);
  await recordAtSeam(l, cfg, "deck_readFocus", {}, run);
  await recordAtSeam(l, cfg, "plugin_build", {}, run);
  assert.deepEqual(lines(l).map((x) => x.tool), ["deck_readFocus", "plugin_build"]);
});

test("machine on a line: plugin tools none, registry tools none unless named, others the resolved one", async () => {
  const l = makeLedger(tmp("machines"));
  const run = async () => ({ ok: true });
  await recordAtSeam(l, cfg, "plugin_build", {}, run);
  await recordAtSeam(l, cfg, "deck_stopAutomation", {}, run);
  await recordAtSeam(l, cfg, "deck_stopAutomation", { machine: "this-pc" }, run);
  await recordAtSeam(l, cfg, "deck_readFocus", { machine: "this-pc" }, run);
  await recordAtSeam(l, cfg, "deck_readFocus", { machine: "nope" }, async () => Promise.reject(new Error("unknown machine")))
    .catch(() => undefined);
  const got = lines(l);
  assert.equal(got[0].machine, null);
  assert.equal(got[1].machine, null);
  assert.deepEqual(got[2].machine, PC);
  assert.deepEqual(got[3].machine, PC);
  assert.equal(got[4].machine, null, "a machine name that does not resolve is not guessed");
  assert.equal(got[4].ok, false);
});

test("index.ts routes every tool call through the ledger, and its rowId list is the tools whose schema has saveAs", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const src = fs.readFileSync(path.join(here, "index.ts"), "utf8");
  const handle = src.slice(src.indexOf("async function handle("), src.indexOf("async function handleCall("));
  assert.match(handle, /recordAtSeam\(/, "handle() must go through the ledger");
  assert.match(handle, /handleCall\(method, args\)/, "and dispatch with the seam's args");

  const block = /const ROW_ID_TOOLS[^=]*=\s*new Set\(\[([\s\S]*?)\]\)/.exec(src);
  assert.ok(block, "ROW_ID_TOOLS not found in index.ts");
  const listed = new Set([...block![1].matchAll(/"([a-z_A-Z]+)"/g)].map((m) => m[1]));
  const withSaveAs = TOOLS.filter((t) => "saveAs" in t.inputSchema.properties).map((t) => t.name);
  for (const name of withSaveAs) assert.ok(listed.has(name), `${name} takes saveAs but index.ts strips its rowId`);
  for (const name of listed) {
    if (name === "deck_runReport") continue;
    assert.ok(withSaveAs.includes(name), `${name} is in ROW_ID_TOOLS but its schema has no saveAs`);
  }
});

test("every deck_ and plugin_ tool in the registry accepts rowId; the evidence tools also accept saveAs", () => {
  for (const t of TOOLS) {
    if (t.name.startsWith("deck_") || t.name.startsWith("plugin_")) {
      assert.ok("rowId" in t.inputSchema.properties, `${t.name} has no rowId`);
    }
  }
  for (const n of [
    "deck_sweep",
    "deck_runSequence",
    "deck_assertFocusMove",
    "deck_walkTo",
    "deck_launchGame",
    "deck_exitGame",
    "deck_snapshotSettings",
    "deck_captureScreenshot",
    "deck_record",
  ]) {
    const t = TOOLS.find((x) => x.name === n)!;
    assert.ok("saveAs" in t.inputSchema.properties, `${n} has no saveAs`);
  }
  const report = TOOLS.find((x) => x.name === "deck_runReport")!;
  assert.deepEqual(Object.keys(report.inputSchema.properties).sort(), ["deadlineMs", "machine", "rowId", "session", "since"]);
});

// ---------------------------------------------------------------------------
// Reading the ledger back
// ---------------------------------------------------------------------------

test("readLedger skips lines that are not ledger JSON and counts them", () => {
  const dir = tmp("read");
  fs.writeFileSync(
    path.join(dir, "20261102T100000Z_pid1.ndjson"),
    [
      JSON.stringify({ ts: "2026-11-02T10:00:00.000Z", tool: "deck_a", ok: true }),
      "{ half a line",
      JSON.stringify({ nope: 1 }),
      "",
      JSON.stringify({ ts: "2026-11-02T10:00:01.000Z", tool: "deck_b", ok: true }),
    ].join("\n"),
  );
  const r = readLedger(dir);
  assert.deepEqual(r.lines.map((x) => x.tool), ["deck_a", "deck_b"]);
  assert.equal(r.malformed, 2);
});

test("a session argument selects a file in the folder and cannot name a path", () => {
  const root = tmp("escape");
  const dir = path.join(root, "ledger");
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, "S1.ndjson"), JSON.stringify({ ts: "2026-11-02T10:00:00.000Z", tool: "deck_a" }) + "\n");
  fs.writeFileSync(path.join(root, "secret.ndjson"), JSON.stringify({ ts: "2026-11-02T10:00:00.000Z", tool: "deck_secret" }) + "\n");
  assert.equal(readLedger(dir, { session: "S1" }).lines.length, 1);
  assert.equal(readLedger(dir, { session: "S1.ndjson" }).lines.length, 1);
  assert.equal(readLedger(dir, { session: "../secret" }).lines.length, 0);
  assert.equal(readLedger(path.join(root, "missing")).lines.length, 0, "no folder is an empty ledger");
});

// ---------------------------------------------------------------------------
// evidenceName.ts
// ---------------------------------------------------------------------------

test("saveAs is a file name: directories are dropped and nothing climbs out", () => {
  assert.equal(sanitizeEvidenceName("../../etc/passwd"), "passwd");
  assert.equal(sanitizeEvidenceName("..\\..\\Windows\\win.ini"), "win.ini");
  assert.equal(sanitizeEvidenceName("C:\\Users\\x\\evidence"), "evidence");
  assert.equal(sanitizeEvidenceName("/abs/olute/name"), "name");
  assert.equal(sanitizeEvidenceName("sub/dir/"), "", "a trailing slash leaves no name");
  assert.equal(sanitizeEvidenceName(".."), "");
  assert.equal(sanitizeEvidenceName("."), "");
  assert.equal(sanitizeEvidenceName("   "), "");
  assert.equal(sanitizeEvidenceName(".hidden"), "hidden");
  assert.equal(sanitizeEvidenceName("a..b"), "a_b");
  assert.equal(sanitizeEvidenceName("P89 open: after reload?"), "P89_open__after_reload_");
  assert.equal(sanitizeEvidenceName("nul"), "_nul", "a Windows device name is not a file");
  assert.equal(sanitizeEvidenceName("COM1.json"), "_COM1.json");
  assert.equal(sanitizeEvidenceName("x".repeat(500)).length, 120);
});

test("the real extension is kept, once, and never taken from the caller", () => {
  assert.equal(withExtension("p89", ".json"), "p89.json");
  assert.equal(withExtension("p89.json", ".json"), "p89.json");
  assert.equal(withExtension("P89.JSON", ".json"), "P89.JSON");
  assert.equal(withExtension("notes.txt", ".png"), "notes.txt.png", "a PNG is never called .txt");
  assert.equal(saveAsFileName("../shot", ".png"), "shot.png");
  assert.equal(saveAsFileName("", ".png"), null);
  assert.equal(saveAsFileName(undefined, ".png"), null);
  assert.equal(saveAsFileName("..", ".png"), null);
});

test("evidencePath: saveAs wins, runName keeps its old rule, then the fallback", () => {
  const dir = path.join("w", "runs");
  assert.equal(evidencePath(dir, { saveAs: "mine", runName: "old", fallback: "f", ext: ".json" }), path.join(dir, "mine.json"));
  assert.equal(evidencePath(dir, { runName: "old name", fallback: "f", ext: ".json" }), path.join(dir, "old_name.json"));
  assert.equal(
    evidencePath(dir, { runName: "x.json", fallback: "f", ext: ".json" }),
    path.join(dir, "x.json.json"),
    "runName is exactly as it always was",
  );
  assert.equal(evidencePath(dir, { fallback: "sweep_1", ext: ".json" }), path.join(dir, "sweep_1.json"));
  assert.equal(evidencePath(dir, { saveAs: "..", fallback: "sweep_1", ext: ".json" }), path.join(dir, "sweep_1.json"), "an unusable saveAs falls through");
  assert.equal(evidencePath(dir, { saveAs: "../../out", fallback: "f", ext: ".png" }), path.join(dir, "out.png"));
});

test("cleanRowId trims, caps and drops what is not text", () => {
  assert.equal(cleanRowId(" P89-RIG-1 "), "P89-RIG-1");
  assert.equal(cleanRowId(42), "42");
  assert.equal(cleanRowId(""), undefined);
  assert.equal(cleanRowId("   "), undefined);
  assert.equal(cleanRowId(undefined), undefined);
  assert.equal(cleanRowId({ a: 1 }), undefined);
  assert.equal(cleanRowId("x".repeat(500))!.length, 200);
});

function withWorkspace<T>(fn: (ws: string) => T): T {
  const ws = tmp("ws");
  const prev = process.env.DECKY_STUDIO_WORKSPACE;
  process.env.DECKY_STUDIO_WORKSPACE = ws;
  try {
    return fn(ws);
  } finally {
    if (prev === undefined) delete process.env.DECKY_STUDIO_WORKSPACE;
    else process.env.DECKY_STUDIO_WORKSPACE = prev;
    fs.rmSync(ws, { recursive: true, force: true });
  }
}

test("a tool with no evidence file of its own writes one when saveAs is given, with the row id inside", () => {
  withWorkspace((ws) => {
    const r = attachNamedEvidence("deck_walkTo", { ok: true, found: true, presses: 3 }, { saveAs: "../../walk-1", rowId: "ROW-9" });
    assert.equal(r.evidenceFile, path.join(ws, "runs", "walk-1.json"));
    assert.equal(r.rowId, "ROW-9");
    const written = JSON.parse(fs.readFileSync(r.evidenceFile!, "utf8"));
    assert.deepEqual(written, { tool: "deck_walkTo", rowId: "ROW-9", ok: true, found: true, presses: 3 });
    assert.equal(fs.existsSync(path.join(ws, "..", "walk-1.json")), false, "nothing escaped runs/");
  });
});

test("without saveAs a result is returned exactly as it was, even with a rowId", () => {
  withWorkspace((ws) => {
    const result = { ok: true };
    const r = attachNamedEvidence("deck_walkTo", result, { rowId: "ROW-9" });
    assert.equal(r, result);
    assert.deepEqual(r, { ok: true });
    assert.equal(fs.existsSync(path.join(ws, "runs")), false, "no file, no folder");
  });
});

test("an evidence write that fails is reported on the result and does not throw", () => {
  withWorkspace((ws) => {
    fs.writeFileSync(path.join(ws, "runs"), "a file where runs/ should be");
    const r = attachNamedEvidence("deck_assertFocusMove", { ok: true }, { saveAs: "x" });
    assert.match(r.evidenceError ?? "", /evidence file could not be written/);
    assert.equal(r.ok, true);
    assert.equal("evidenceFile" in r, false);
  });
});

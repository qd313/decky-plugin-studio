/**
 * Tests for deck_runReport (tools/runReport.ts): filters, the markdown block,
 * the totals line, and the sentences that stop a report over-claiming.
 *
 * A report is a rendering of ledger lines these tests write by hand or through
 * the real Ledger; they cannot say the block matches bonsAI's testing.md column
 * for column (it has no fixed table to match), only that every fact a row needs
 * is in it.
 */
process.env.DPS_NO_BRIDGE ??= "1";

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Ledger, LedgerLine } from "../ledger.js";
import { parseSince, runReport, totalsOf } from "./runReport.js";

function tmp(label: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `dps-report-${label}-`));
}

function line(over: Partial<LedgerLine> & { tool: string; ts: string }): LedgerLine {
  return {
    session: "S1",
    machine: { name: "deck", kind: "deck", os: "steamos" },
    ok: true,
    durationMs: 120,
    ...over,
  };
}

function writeSession(dir: string, session: string, ls: LedgerLine[]): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${session}.ndjson`), ls.map((l) => JSON.stringify({ ...l, session })).join("\n") + "\n");
}

const NOW = Date.parse("2026-11-02T15:00:00Z");

function ctx(dir: string, ws: string, session = "CURRENT") {
  return { dir, currentSession: session, workspaceRoot: ws, now: () => NOW };
}

test("with no arguments it reports this server's own session and nothing else", () => {
  const ws = tmp("default");
  const dir = path.join(ws, "runs", "ledger");
  writeSession(dir, "CURRENT", [line({ tool: "deck_readFocus", ts: "2026-11-02T14:00:00.000Z" })]);
  writeSession(dir, "OLDER", [line({ tool: "deck_pressButton", ts: "2026-11-01T14:00:00.000Z" })]);
  const r = runReport({}, ctx(dir, ws));
  assert.equal(r.session, "CURRENT");
  assert.equal(r.totals.calls, 1);
  assert.match(r.markdown, /deck_readFocus/);
  assert.doesNotMatch(r.markdown, /deck_pressButton/);
});

test("a row with its calls across two sessions is one report", () => {
  const ws = tmp("row");
  const dir = path.join(ws, "runs", "ledger");
  writeSession(dir, "A", [
    line({ tool: "deck_walkTo", ts: "2026-11-02T10:00:00.000Z", rowId: "ROW-1", presses: 5, fidelity: "wire-sent" }),
    line({ tool: "deck_readFocus", ts: "2026-11-02T10:00:05.000Z" }),
  ]);
  writeSession(dir, "B", [
    line({ tool: "deck_sweep", ts: "2026-11-02T12:00:00.000Z", rowId: "ROW-1", presses: 11 }),
    line({ tool: "deck_sweep", ts: "2026-11-02T12:05:00.000Z", rowId: "ROW-2", presses: 99 }),
  ]);
  const r = runReport({ rowId: "ROW-1" }, ctx(dir, ws));
  assert.equal(r.session, "all");
  assert.equal(r.rowId, "ROW-1");
  assert.deepEqual(Object.keys(r.totals.byTool).sort(), ["deck_sweep", "deck_walkTo"]);
  assert.equal(r.totals.presses, 16);
  assert.match(r.markdown, /row `ROW-1`/);
  assert.match(r.markdown, /\| Row \|/, "a Row column appears when any line has a row id");
  assert.equal(r.files.length, 2);
});

test("since takes an ISO time or a span back from now", () => {
  const ws = tmp("since");
  const dir = path.join(ws, "runs", "ledger");
  writeSession(dir, "A", [
    line({ tool: "deck_a", ts: "2026-11-02T13:00:00.000Z" }),
    line({ tool: "deck_b", ts: "2026-11-02T14:20:00.000Z" }),
    line({ tool: "deck_c", ts: "2026-11-02T14:50:00.000Z" }),
  ]);
  assert.deepEqual(Object.keys(runReport({ since: "2026-11-02T14:00:00Z" }, ctx(dir, ws)).totals.byTool), ["deck_b", "deck_c"]);
  assert.deepEqual(Object.keys(runReport({ since: "1h" }, ctx(dir, ws)).totals.byTool), ["deck_b", "deck_c"]);
  assert.deepEqual(Object.keys(runReport({ since: "30m" }, ctx(dir, ws)).totals.byTool), ["deck_c"]);
  assert.equal(runReport({ since: "30m" }, ctx(dir, ws)).since, new Date(NOW - 30 * 60_000).toISOString());
  assert.equal(parseSince("2d", NOW), NOW - 2 * 86_400_000);
  assert.throws(() => parseSince("yesterday-ish", NOW), /since must be an ISO date or time/);
  assert.throws(() => runReport({ since: "soon" }, ctx(dir, ws)), /since must be/);
});

test("machine and session filters", () => {
  const ws = tmp("filters");
  const dir = path.join(ws, "runs", "ledger");
  writeSession(dir, "A", [
    line({ tool: "deck_a", ts: "2026-11-02T10:00:00.000Z" }),
    line({ tool: "deck_b", ts: "2026-11-02T10:01:00.000Z", machine: { name: "this-pc", kind: "standin", os: "windows" } }),
  ]);
  writeSession(dir, "B", [line({ tool: "deck_c", ts: "2026-11-02T11:00:00.000Z" })]);
  assert.deepEqual(Object.keys(runReport({ session: "A", machine: "this-pc" }, ctx(dir, ws)).totals.byTool), ["deck_b"]);
  assert.equal(runReport({ session: "all" }, ctx(dir, ws)).totals.calls, 3);
  assert.equal(runReport({ session: "B.ndjson" }, ctx(dir, ws)).totals.calls, 1);
  assert.equal(runReport({ session: "../A" }, ctx(dir, ws)).totals.calls, 0, "a session cannot name a path");
});

test("the block carries tool, machine, build, verdict and evidence, with the path relative to the workspace", () => {
  const ws = tmp("block");
  const dir = path.join(ws, "runs", "ledger");
  const hash = "0123456789abcdef".repeat(4);
  writeSession(dir, "CURRENT", [
    line({
      tool: "deck_walkTo",
      ts: "2026-11-02T14:00:00.000Z",
      presses: 4,
      fidelity: "wire-sent",
      durationMs: 2300,
      buildHash: hash,
      buildMatches: true,
      evidenceFile: path.join(ws, "runs", "walk-1.json"),
      stateReadAt: "2026-11-02T13:59:00.000Z",
      runningGame: { appid: 220, name: "Half-Life 2" },
    }),
    line({ tool: "deck_launchGame", ts: "2026-11-02T14:01:00.000Z", ok: false, error: "Play button read Install | no", buildMatches: false }),
    line({ tool: "deck_openPlugin", ts: "2026-11-02T14:02:00.000Z", ok: false, error: "deck_openPlugin did not finish within its deadline of 300 ms", deadline: true }),
    line({ tool: "deck_sweep", ts: "2026-11-02T14:03:00.000Z", stopped: true, presses: 2 }),
  ]);
  const r = runReport({}, ctx(dir, ws));
  const md = r.markdown;
  assert.match(md, /\| 1 \| 2026-11-02 14:00:00Z \| deck_walkTo \| deck \(deck, steamos\) \| `0123456789ab` \| ok · wire-sent · 4 presses · 2\.3 s \| `runs\/walk-1\.json` \|/);
  assert.match(md, /\| deck_launchGame \| .* \| differs from local \| FAILED: Play button read Install \\\| no \| none \|/, "a pipe in an error cannot break the table");
  assert.match(md, /DEADLINE: deck_openPlugin did not finish/);
  assert.match(md, /STOPPED · 2 presses/);
  assert.match(md, /Game, last read: Half-Life 2 \(220\), read 2026-11-02 13:59:00Z\./);
  assert.match(md, /not that the row passed/, "the verdict caveat is part of the block");
  assert.equal(r.totals.calls, 4);
  assert.equal(r.totals.ok, 2);
  assert.equal(r.totals.failed, 2);
  assert.equal(r.totals.deadlines, 1);
  assert.equal(r.totals.stopped, 1);
  assert.equal(r.totals.evidenceFiles, 1);
  assert.equal(r.totals.presses, 6);
  assert.equal(
    r.totalsLine,
    "Totals: 4 calls: 2 ok, 2 failed (1 past their deadline, 1 stopped by the killswitch); 6 presses sent; 1 evidence file; machines: deck (deck) x4.",
  );
  assert.ok(md.includes(r.totalsLine), "the totals line is in the block");
  assert.doesNotMatch(md, /stand-in runs/);
});

test("a build nothing recent knew reads 'not read', never a blank or a guess", () => {
  const ws = tmp("notread");
  const dir = path.join(ws, "runs", "ledger");
  writeSession(dir, "CURRENT", [line({ tool: "deck_readFocus", ts: "2026-11-02T14:00:00.000Z" })]);
  assert.match(runReport({}, ctx(dir, ws)).markdown, /\| not read \|/);
});

test("a report that includes a stand-in says so, and a machine-less call shows 'none'", () => {
  const ws = tmp("standin");
  const dir = path.join(ws, "runs", "ledger");
  writeSession(dir, "CURRENT", [
    line({ tool: "deck_readFocus", ts: "2026-11-02T14:00:00.000Z", machine: { name: "this-pc", kind: "standin", os: "windows" } }),
    line({ tool: "plugin_build", ts: "2026-11-02T14:01:00.000Z", machine: null }),
  ]);
  const r = runReport({}, ctx(dir, ws));
  assert.match(r.markdown, /this-pc \(standin, windows\)/);
  assert.match(r.markdown, /Includes stand-in runs \(`kind: standin`\): do not file those as the Deck's verdict\./);
  assert.match(r.markdown, /\| plugin_build \| none \|/);
  assert.match(r.totalsLine, /machines: this-pc \(standin\) x1, no machine x1\./);
});

test("an empty selection says so, names where it looked, and is still ok", () => {
  const ws = tmp("empty");
  const dir = path.join(ws, "runs", "ledger");
  const none = runReport({ rowId: "NOPE" }, ctx(dir, ws));
  assert.equal(none.ok, true);
  assert.equal(none.totals.calls, 0);
  assert.match(none.markdown, /No ledger found for this selection \(looked in /);
  assert.equal(none.totalsLine, "Totals: no calls matched.");

  writeSession(dir, "CURRENT", [line({ tool: "deck_a", ts: "2026-11-02T14:00:00.000Z" })]);
  assert.match(runReport({ rowId: "NOPE" }, ctx(dir, ws)).markdown, /The ledger has no line matching this selection\./);
});

test("unreadable lines are counted in the report, not hidden", () => {
  const ws = tmp("malformed");
  const dir = path.join(ws, "runs", "ledger");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "CURRENT.ndjson"),
    JSON.stringify(line({ tool: "deck_a", ts: "2026-11-02T14:00:00.000Z" })) + "\n{ torn\n",
  );
  const r = runReport({}, ctx(dir, ws));
  assert.equal(r.malformed, 1);
  assert.match(r.markdown, /1 ledger line could not be read and was skipped/);
});

test("totalsOf counts a line once however many facts it carries", () => {
  const t = totalsOf([
    line({ tool: "deck_a", ts: "x", presses: 2, evidenceFile: "f" }),
    line({ tool: "deck_a", ts: "x", ok: false, deadline: true }),
  ]);
  assert.deepEqual(t, { calls: 2, ok: 1, failed: 1, deadlines: 1, stopped: 0, presses: 2, evidenceFiles: 1, byTool: { deck_a: 2 } });
});

test("end to end: lines written by the real Ledger are what the report renders", async () => {
  const ws = tmp("e2e");
  const dir = path.join(ws, "runs", "ledger");
  const l = new Ledger({ dir: () => dir, pid: 77, startedAt: Date.parse("2026-11-02T14:00:00Z"), log: () => {} });
  const machine = { name: "this-pc", kind: "standin", os: "windows" };
  for (let i = 0; i < 5; i++) {
    await l.record(
      { tool: i === 3 ? "deck_walkTo" : "deck_readFocus", args: {}, rowId: "E2E", machineOf: () => machine },
      async () => (i === 4 ? Promise.reject(new Error("tunnel refused")) : { ok: true, presses: i === 3 ? 6 : undefined, fidelity: i === 3 ? "wire-sent" : undefined }),
    ).catch(() => undefined);
  }
  const r = runReport({}, { dir, currentSession: l.session, workspaceRoot: ws });
  assert.equal(r.session, l.session);
  assert.equal(r.totals.calls, 5, "five calls, five lines");
  assert.equal(r.totals.failed, 1);
  assert.equal(r.totals.presses, 6);
  assert.match(r.markdown, /FAILED: tunnel refused/);
});

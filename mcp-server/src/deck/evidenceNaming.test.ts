/**
 * saveAs and rowId on the evidence-writing tools (plan 12, lane C).
 *
 * Each case runs the real tool against a fake CDP server or an unreachable one,
 * so the file is written by the tool's own code path. What this cannot show:
 * a recording or a screenshot named by saveAs (those need the capture scripts;
 * their naming is evidencePath(), tested in ledger.test.ts) and a snapshot
 * (needs ssh; its wrapper is attachNamedEvidence(), also tested there).
 */
process.env.DPS_NO_BRIDGE ??= "1";

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { startFakeCdp, focusedPage } from "./__testutil__/fakeCdp.js";
import { sweep } from "./sweep.js";
import { runSequence } from "./runSequence.js";
import { walkTo } from "./walkTo.js";
import { assertFocusMove } from "./assertFocusMove.js";

async function inWorkspace<T>(fn: (ws: string) => Promise<T>): Promise<T> {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "dps-evidence-"));
  const prev = process.env.DECKY_STUDIO_WORKSPACE;
  process.env.DECKY_STUDIO_WORKSPACE = ws;
  try {
    return await fn(ws);
  } finally {
    if (prev === undefined) delete process.env.DECKY_STUDIO_WORKSPACE;
    else process.env.DECKY_STUDIO_WORKSPACE = prev;
    fs.rmSync(ws, { recursive: true, force: true });
  }
}

test("deck_sweep: saveAs names the file, rowId goes in it, and neither leaves runs/", async () => {
  await inWorkspace(async (ws) => {
    const fake = await startFakeCdp(["QuickAccess_uid2"], () => focusedPage);
    try {
      const r = await sweep({ cdpUrl: fake.base, saveAs: "../../p12c sweep", rowId: "ROW-S", runName: "ignored" });
      assert.equal(r.evidenceFile, path.join(ws, "runs", "p12c_sweep.json"));
      const written = JSON.parse(fs.readFileSync(r.evidenceFile!, "utf8"));
      assert.equal(written.rowId, "ROW-S");
      assert.equal(written.tool, "deck_sweep");
      assert.equal(fs.existsSync(path.join(ws, "runs", "ignored.json")), false, "saveAs wins over runName");
      assert.equal(fs.readdirSync(ws).join(","), "runs");
    } finally {
      await fake.close();
    }
  });
});

test("deck_sweep: without a rowId the file has no rowId key (a baseline diff stays clean)", async () => {
  await inWorkspace(async () => {
    const fake = await startFakeCdp(["QuickAccess_uid2"], () => focusedPage);
    try {
      const r = await sweep({ cdpUrl: fake.base, saveAs: "plain.json" });
      assert.match(r.evidenceFile ?? "", /plain\.json$/);
      assert.equal("rowId" in JSON.parse(fs.readFileSync(r.evidenceFile!, "utf8")), false);
    } finally {
      await fake.close();
    }
  });
});

test("deck_runSequence: saveAs asks for the file the way runName does, and rowId is in it", async () => {
  await inWorkspace(async (ws) => {
    const fake = await startFakeCdp(["QuickAccess_uid2"], () => focusedPage);
    try {
      const r = await runSequence({ steps: [{ press: "NOT_A_BUTTON" }], cdpUrl: fake.base, saveAs: "seq-1", rowId: "ROW-Q" });
      assert.equal(r.evidenceFile, path.join(ws, "runs", "seq-1.json"));
      assert.equal(r.rowId, "ROW-Q");
      assert.equal(JSON.parse(fs.readFileSync(r.evidenceFile!, "utf8")).rowId, "ROW-Q");

      const bare = await runSequence({ steps: [{ press: "NOT_A_BUTTON" }], cdpUrl: fake.base });
      assert.equal(bare.evidenceFile, null, "an unnamed exploratory run still leaves nothing behind");
      assert.equal("rowId" in bare, false);
    } finally {
      await fake.close();
    }
  });
});

test("deck_walkTo: saveAs gives a walk the file it never had; without it nothing is written", async () => {
  await inWorkspace(async (ws) => {
    const r = await walkTo({ direction: "DOWN", text: "bonsAI", cdpUrl: "http://127.0.0.1:1", saveAs: "walk-a", rowId: "ROW-W" });
    assert.equal(r.ok, false);
    assert.equal(r.evidenceFile, path.join(ws, "runs", "walk-a.json"), "a refused run is evidence too");
    const written = JSON.parse(fs.readFileSync(r.evidenceFile!, "utf8"));
    assert.equal(written.tool, "deck_walkTo");
    assert.equal(written.rowId, "ROW-W");
    assert.equal(written.presses, 0);

    const bare = await walkTo({ direction: "DOWN", text: "bonsAI", cdpUrl: "http://127.0.0.1:1", rowId: "ROW-W" });
    assert.equal("evidenceFile" in bare, false);
    assert.deepEqual(fs.readdirSync(path.join(ws, "runs")), ["walk-a.json"]);
  });
});

test("deck_assertFocusMove: saveAs writes the result; the result is otherwise unchanged", async () => {
  await inWorkspace(async (ws) => {
    const r = await assertFocusMove({ press: "DOWN", cdpUrl: "http://127.0.0.1:1", saveAs: "afm", rowId: "ROW-A" });
    assert.equal(r.evidenceFile, path.join(ws, "runs", "afm.json"));
    const written = JSON.parse(fs.readFileSync(r.evidenceFile!, "utf8"));
    assert.equal(written.tool, "deck_assertFocusMove");
    assert.equal(written.rowId, "ROW-A");
    assert.deepEqual(written.press, ["DOWN"]);

    const bare = await assertFocusMove({ press: "DOWN", cdpUrl: "http://127.0.0.1:1" });
    assert.equal("evidenceFile" in bare, false);
  });
});

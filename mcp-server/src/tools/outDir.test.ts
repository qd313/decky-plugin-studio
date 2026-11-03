/**
 * Plan 12 lane B: run files go where the caller says.
 *
 * Every tool that writes under runs/ or screenshots/ takes an optional
 * `outDir` (absolute, or relative to the workspace). Nothing here touches a
 * Deck: the sweep and runSequence cases read a fake CDP server, and the
 * screenshot case never gets past the machine check.
 */
process.env.DPS_NO_BRIDGE ??= "1";

import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { checkOutDir, defaultArtifactsDirs, getWorkspaceArtifactsDir } from "./captureOrchestrator.js";
import { sweep } from "../deck/sweep.js";
import { runSequence } from "../deck/runSequence.js";
import { getEnv } from "./deckAutonomy.js";
import { normalizeMachine, runWithMachine } from "../machines.js";
import { startFakeCdp, focusedPage } from "../deck/__testutil__/fakeCdp.js";
import { TOOLS } from "../toolRegistry.js";

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "dps-outdir-ws-"));
const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "dps-outdir-else-"));
const previous = process.env.DECKY_STUDIO_WORKSPACE;
process.env.DECKY_STUDIO_WORKSPACE = workspace;

after(() => {
  if (previous === undefined) delete process.env.DECKY_STUDIO_WORKSPACE;
  else process.env.DECKY_STUDIO_WORKSPACE = previous;
  fs.rmSync(workspace, { recursive: true, force: true });
  fs.rmSync(elsewhere, { recursive: true, force: true });
});

test("checkOutDir refuses empty, blank, non-string, NUL, a filesystem root and an existing file", () => {
  assert.match(checkOutDir("") ?? "", /empty/);
  assert.match(checkOutDir("   ") ?? "", /empty/);
  assert.match(checkOutDir(42) ?? "", /must be a string/);
  assert.match(checkOutDir("a\0b") ?? "", /NUL/);
  assert.match(checkOutDir(path.parse(workspace).root) ?? "", /filesystem root/);
  const file = path.join(workspace, "a-file.txt");
  fs.writeFileSync(file, "x");
  assert.match(checkOutDir(file) ?? "", /not a directory/);
  assert.match(checkOutDir("a-file.txt") ?? "", /not a directory/, "relative paths resolve against the workspace");
});

test("checkOutDir accepts an absolute path, a relative one, and a folder that does not exist yet", () => {
  assert.equal(checkOutDir(elsewhere), null);
  assert.equal(checkOutDir("evidence/2026-11"), null);
  assert.equal(checkOutDir(path.join(elsewhere, "not", "yet")), null);
});

test("getWorkspaceArtifactsDir: no outDir is the old default; outDir is absolute or workspace-relative and gets created", () => {
  assert.equal(getWorkspaceArtifactsDir("runs"), path.join(workspace, "runs"));
  assert.equal(getWorkspaceArtifactsDir("screenshots", null), path.join(workspace, "screenshots"));
  assert.ok(fs.statSync(path.join(workspace, "runs")).isDirectory());

  const abs = path.join(elsewhere, "deep", "runs");
  assert.equal(getWorkspaceArtifactsDir("runs", abs), abs);
  assert.ok(fs.statSync(abs).isDirectory());

  assert.equal(getWorkspaceArtifactsDir("recordings", "out/rec"), path.join(workspace, "out", "rec"));
  assert.ok(fs.statSync(path.join(workspace, "out", "rec")).isDirectory());

  assert.throws(() => getWorkspaceArtifactsDir("runs", ""), /outDir is empty/);
});

test("defaultArtifactsDirs reports the three defaults under the workspace root", () => {
  assert.deepEqual(defaultArtifactsDirs(), {
    runs: path.join(workspace, "runs"),
    screenshots: path.join(workspace, "screenshots"),
    recordings: path.join(workspace, "recordings"),
  });
});

test("deck_getEnv reports artifactDirs", async () => {
  // A local stand-in with no press transport: nothing to ssh to, nothing to press.
  const m = normalizeMachine("outdir-env", { kind: "standin", os: "windows", local: true, press: "none" });
  const env = (await runWithMachine(m, () => getEnv())) as Record<string, unknown>;
  assert.deepEqual(env.artifactDirs, defaultArtifactsDirs());
});

test("deck_sweep writes its evidence to outDir when given, and under runs/ when not", async () => {
  const fake = await startFakeCdp(["QuickAccess_uid2"], () => focusedPage);
  try {
    const dir = path.join(elsewhere, "sweeps");
    const named = await sweep({ cdpUrl: fake.base, runName: "to-outdir", outDir: dir });
    assert.equal(named.evidenceFile, path.join(dir, "to-outdir.json"));
    assert.ok(fs.existsSync(named.evidenceFile!));
    assert.equal(fs.existsSync(path.join(workspace, "runs", "to-outdir.json")), false, "nothing left in the default folder");

    const relative = await sweep({ cdpUrl: fake.base, runName: "to-relative", outDir: "ev/sweeps" });
    assert.equal(relative.evidenceFile, path.join(workspace, "ev", "sweeps", "to-relative.json"));

    const dflt = await sweep({ cdpUrl: fake.base, runName: "to-default" });
    assert.equal(dflt.evidenceFile, path.join(workspace, "runs", "to-default.json"));
  } finally {
    await fake.close();
  }
});

test("deck_runSequence writes its evidence to outDir when given", async () => {
  const fake = await startFakeCdp(["QuickAccess_uid2"], () => focusedPage);
  try {
    const dir = path.join(elsewhere, "sequences");
    const r = await runSequence({ steps: [{ press: "DOWN" }], cdpUrl: fake.base, runName: "seq-outdir", outDir: dir, acquireFocus: false });
    assert.equal(r.evidenceFile, path.join(dir, "seq-outdir.json"));
    assert.ok(fs.existsSync(r.evidenceFile!));
  } finally {
    await fake.close();
  }
});

test("every tool that writes run files declares outDir; the others do not", () => {
  const withOutDir = TOOLS.filter((t) => "outDir" in ((t.inputSchema as { properties?: Record<string, unknown> }).properties ?? {})).map(
    (t) => t.name,
  );
  assert.deepEqual(withOutDir.sort(), [
    "deck_captureScreenshot",
    "deck_exitGame",
    "deck_launchGame",
    "deck_record",
    "deck_runSequence",
    "deck_sweep",
  ]);
});

test("deck_replayChecks declares names, all and maxChecks, and keeps only as the older spelling", () => {
  const t = TOOLS.find((x) => x.name === "deck_replayChecks")!;
  const props = (t.inputSchema as { properties: Record<string, unknown> }).properties;
  for (const k of ["names", "only", "all", "maxChecks"]) assert.ok(k in props, k);
  assert.match(t.description, /more than maxChecks/);
});

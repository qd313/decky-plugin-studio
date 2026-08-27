/*
 * Packaging-omission smoke test -- the third of its kind (VSIX missed MCP
 * node_modules; VSIX missed bridge/tools/; now this).
 *
 * getScriptsDir() used to resolve the capture scripts directory as a single
 * hardcoded `../scripts` relative to captureOrchestrator's own compiled file.
 * That is right for a built `dist/tools/captureOrchestrator.js` (and the VSIX
 * bundle, which mirrors the same shape), but wrong for the source-tree file
 * `src/tools/captureOrchestrator.ts` running under `tsx` -- which is exactly
 * how `npm run dev` runs it, the configuration this repo's own `mcp.json`
 * warning pushes consumers toward. From there it resolved to
 * `mcp-server/src/scripts`, a directory no build step ever creates, and
 * every capture tool call failed with "Missing capture scripts: ...".
 *
 * These tests call the real resolution path in both layouts that diverge --
 * compiled dist and source-tree tsx -- so a future regression here fails the
 * build, not a user's Deck session.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";

import { getScriptsDir, bundleDeckScript, resolveScriptsDir } from "./captureOrchestrator.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const mcpServerRoot = path.join(here, "..", "..");

test("source-tree (tsx) layout: getScriptsDir finds the real scripts and bundleDeckScript produces a script", () => {
  // The suite itself runs this file via `tsx`, so captureOrchestrator's own
  // import.meta.url points at src/tools/captureOrchestrator.ts here -- the
  // exact layout that used to resolve to a src/scripts directory that never
  // existed. This is a regression test for that failure, exercised for real
  // rather than simulated.
  const dir = getScriptsDir();
  assert.ok(
    fs.existsSync(path.join(dir, "deck", "studio-capture-common.sh")),
    `expected ${dir} to contain deck/studio-capture-common.sh`
  );

  const bundle = bundleDeckScript("studio-capture.sh");
  assert.match(bundle, /^#!/);
  assert.match(bundle, /STUDIO_CAPTURE_COMMON_LOADED=1/);
});

test("compiled dist layout: getScriptsDir finds dist/scripts and bundleDeckScript produces a script", async () => {
  const distEntry = path.join(mcpServerRoot, "dist", "tools", "captureOrchestrator.js");
  assert.ok(
    fs.existsSync(distEntry),
    `expected a build to have produced ${distEntry} first (the test script runs tsc before the tests)`
  );

  const mod = (await import(pathToFileURL(distEntry).href)) as typeof import("./captureOrchestrator.js");
  const dir = mod.getScriptsDir();
  assert.equal(dir, path.join(mcpServerRoot, "dist", "scripts"));
  assert.ok(fs.existsSync(path.join(dir, "deck", "studio-capture-common.sh")));

  const bundle = mod.bundleDeckScript("studio-capture.sh");
  assert.match(bundle, /^#!/);
  assert.match(bundle, /STUDIO_CAPTURE_COMMON_LOADED=1/);
});

test("resolution tries candidates in order and returns the first that has the scripts", () => {
  const missing = path.join(os.tmpdir(), "decky-studio-test-missing-" + Math.random().toString(36).slice(2));
  const real = fs.mkdtempSync(path.join(os.tmpdir(), "decky-studio-test-real-"));
  fs.mkdirSync(path.join(real, "deck"));
  try {
    assert.equal(resolveScriptsDir([missing, real]), real);
  } finally {
    fs.rmSync(real, { recursive: true, force: true });
  }
});

test("resolution failure names every location it tried", () => {
  const a = path.join(os.tmpdir(), "decky-studio-test-a-" + Math.random().toString(36).slice(2));
  const b = path.join(os.tmpdir(), "decky-studio-test-b-" + Math.random().toString(36).slice(2));
  assert.throws(
    () => resolveScriptsDir([a, b]),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.ok(err.message.includes(a), `error should mention ${a}`);
      assert.ok(err.message.includes(b), `error should mention ${b}`);
      return true;
    }
  );
});

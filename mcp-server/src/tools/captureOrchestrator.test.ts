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

import { getScriptsDir, bundleDeckScript, resolveScriptsDir, scriptsDirCandidatesFrom } from "./captureOrchestrator.js";

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

// ---------------------------------------------------------------------------
// Issue #2 (bonsAI, 2026-08-30): "Could not find the capture scripts
// directory. Tried: \c:\Users\...\mcp-server\dist\scripts" -- the same path
// twice. The module URL was turned into a path by a regex that recognised
// only an upper-case drive letter, and bonsAI's mcp.json path is `c:/...`.
// The compiled-layout test above never saw it because pathToFileURL on the
// machine that runs the suite produces `C:`. These feed the resolver the
// exact URL shapes consumers run us from.
// ---------------------------------------------------------------------------

test("issue #2: a lower-case drive letter in the module URL yields real absolute paths, never \\c:\\...", () => {
  const url = "file:///c:/Users/still/decky-plugin-studio/mcp-server/dist/tools/captureOrchestrator.js";
  const cands = scriptsDirCandidatesFrom(url);
  assert.ok(cands.length >= 2, JSON.stringify(cands));
  for (const c of cands) {
    assert.ok(path.isAbsolute(c), `not absolute: ${c}`);
    assert.ok(!c.startsWith("\\"), `the reported malformed shape: ${c}`);
    if (process.platform === "win32") {
      assert.match(c, /^[a-z]:\\/i, `expected a drive-letter path, got ${c}`);
    }
  }
  if (process.platform === "win32") {
    assert.equal(
      cands[0].toLowerCase(),
      "c:\\users\\still\\decky-plugin-studio\\mcp-server\\dist\\scripts"
    );
  }
});

test("issue #2: the candidate list never names the same directory twice", () => {
  const url = "file:///C:/dps/mcp-server/dist/tools/captureOrchestrator.js";
  const cands = scriptsDirCandidatesFrom(url);
  const norm = cands.map((c) => c.toLowerCase());
  assert.equal(new Set(norm).size, norm.length, `duplicates in ${JSON.stringify(cands)}`);
  // From dist/tools, `../scripts` and `../../dist/scripts` are one directory
  // -- the "printed twice" in the report -- so exactly one survives.
  const distScripts = path.join("dist", "scripts").toLowerCase();
  assert.equal(norm.filter((c) => c.endsWith(distScripts)).length, 1, JSON.stringify(cands));
});

test("issue #2: DECKY_STUDIO_REPO adds a fallback that does not depend on where the module runs from", () => {
  const url = "file:///C:/somewhere/else/bundle/tools/captureOrchestrator.js";
  const repo = path.join(os.tmpdir(), "dps-repo-root");
  const withRepo = scriptsDirCandidatesFrom(url, repo);
  assert.equal(withRepo[withRepo.length - 1], path.resolve(path.join(repo, "templates", "scripts")));
  const without = scriptsDirCandidatesFrom(url);
  assert.ok(!without.some((c) => c.startsWith(path.resolve(repo))), "unset means no such candidate");
  assert.equal(scriptsDirCandidatesFrom(url, "   ").length, without.length, "blank is unset");
});

test("issue #2: a percent-encoded segment (a space in a user name) decodes to the real directory", () => {
  const url = "file:///C:/Users/still%20jammin/dps/mcp-server/dist/tools/captureOrchestrator.js";
  const [first] = scriptsDirCandidatesFrom(url);
  assert.ok(first.includes("still jammin"), first);
  assert.ok(!first.includes("%20"), first);
});

test("issue #2, end to end: the real dist/scripts is found from a lower-case-drive module URL", () => {
  const distEntry = path.join(mcpServerRoot, "dist", "tools", "captureOrchestrator.js");
  assert.ok(fs.existsSync(distEntry), `expected a build to have produced ${distEntry} first`);
  let url = pathToFileURL(distEntry).href;
  if (process.platform === "win32") {
    url = url.replace(/^file:\/\/\/([A-Z]):/, (_m, d: string) => `file:///${d.toLowerCase()}:`);
    assert.match(url, /^file:\/\/\/[a-z]:/, "the test must actually exercise the lower-case shape");
  }
  const dir = resolveScriptsDir(scriptsDirCandidatesFrom(url));
  assert.ok(fs.existsSync(path.join(dir, "deck", "studio-capture-common.sh")), dir);
  assert.equal(path.resolve(dir).toLowerCase(), path.join(mcpServerRoot, "dist", "scripts").toLowerCase());
});

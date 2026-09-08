/*
 * Part 2: prove the capture scripts resolve from a packaged build, not just
 * from mcp-server's own dist.
 *
 * The existing tests in captureOrchestrator.test.ts exercise
 * scriptsDirCandidatesFrom()/resolveScriptsDir() against fabricated URLs and
 * fabricated temp directories (plus mcp-server's own compiled dist). None of
 * them exercise the shape a *packaged* mcp-server actually has once
 * bundle-for-vsix.mjs relocates it to extension/resources/mcp-server: a
 * standalone `dist/tools/captureOrchestrator.js` with no source tree and no
 * templates/ three directories up. verifyPackagedScripts() is the function
 * bundle-for-vsix.mjs calls against exactly that layout, and fails packaging
 * when it does not pass -- see the comment above its call there.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

import { verifyPackagedScripts } from "./captureOrchestrator.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const mcpServerRoot = path.join(here, "..", "..");
const repoRoot = path.join(mcpServerRoot, "..");

/**
 * A directory shaped like `extension/resources/mcp-server`: a `dist/`
 * containing `tools/captureOrchestrator.js`, isolated under the OS temp dir
 * so no relative candidate can accidentally resolve to this repo's own
 * templates/scripts fallback.
 */
function makePackagedRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "decky-packaged-mcp-"));
  fs.mkdirSync(path.join(root, "dist", "tools"), { recursive: true });
  // Content is irrelevant -- verifyPackagedScripts only needs this file's
  // path, the same way the real check imports the real compiled file without
  // needing it to do anything at import time.
  fs.writeFileSync(path.join(root, "dist", "tools", "captureOrchestrator.js"), "// placeholder\n");
  return root;
}

test("fails when the packaged bundle has no scripts directory at all", () => {
  const root = makePackagedRoot();
  try {
    const check = verifyPackagedScripts(root);
    assert.equal(check.ok, false);
    if (!check.ok) {
      assert.ok(check.error, "expected an error naming every location tried");
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("fails, naming what's missing, when the scripts directory exists but a required script does not", () => {
  const root = makePackagedRoot();
  try {
    const deckDir = path.join(root, "dist", "scripts", "deck");
    fs.mkdirSync(deckDir, { recursive: true });
    // Only the common script is present -- studio-capture.sh and
    // studio-record.sh, which bundleDeckScript() also needs, are not.
    fs.writeFileSync(path.join(deckDir, "studio-capture-common.sh"), "#!/bin/sh\n");

    const check = verifyPackagedScripts(root);
    assert.equal(check.ok, false);
    if (!check.ok) {
      assert.ok(check.missing, "expected the missing list to be populated");
      assert.ok(check.missing!.some((m) => m.includes("studio-capture.sh")));
      assert.ok(check.missing!.some((m) => m.includes("studio-record.sh")));
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("passes when every required script is present in the packaged bundle", () => {
  const root = makePackagedRoot();
  try {
    const realDeckScripts = path.join(repoRoot, "templates", "scripts", "deck");
    const deckDir = path.join(root, "dist", "scripts", "deck");
    fs.mkdirSync(deckDir, { recursive: true });
    for (const name of ["studio-capture-common.sh", "studio-capture.sh", "studio-record.sh"]) {
      fs.copyFileSync(path.join(realDeckScripts, name), path.join(deckDir, name));
    }

    const check = verifyPackagedScripts(root);
    assert.equal(check.ok, true, JSON.stringify(check));
    if (check.ok) {
      assert.equal(path.resolve(check.scriptsDir), path.resolve(path.join(root, "dist", "scripts")));
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("real artifact: the actual compiled mcp-server dist resolves its scripts (not a fabricated fixture)", () => {
  const distEntry = path.join(mcpServerRoot, "dist", "tools", "captureOrchestrator.js");
  assert.ok(
    fs.existsSync(distEntry),
    `expected a build to have produced ${distEntry} first (the test script runs tsc before the tests)`
  );

  const check = verifyPackagedScripts(mcpServerRoot);
  assert.equal(check.ok, true, JSON.stringify(check));
});

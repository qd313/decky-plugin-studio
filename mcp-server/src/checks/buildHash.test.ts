/**
 * Tests for checks.buildHash.
 *
 * All pure filesystem operations against a scratch plugin tree -- no Deck,
 * no CDP, nothing that could touch a real device.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { computeBuildHash } from "./buildHash.js";

function makePlugin(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dps-buildhash-"));
  fs.writeFileSync(path.join(root, "plugin.json"), JSON.stringify({ name: "sample", version: "1.0.0" }));
  fs.mkdirSync(path.join(root, "dist"));
  fs.writeFileSync(path.join(root, "dist", "index.js"), "// built v1");
  fs.writeFileSync(path.join(root, "main.py"), "# entry");
  return root;
}

test("the same build produces the same hash", () => {
  const root = makePlugin();
  try {
    const a = computeBuildHash(root);
    const b = computeBuildHash(root);
    assert.equal(a.hash, b.hash);
    assert.match(a.hash, /^sha256:[0-9a-f]{64}$/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("changed bundle content changes the hash", () => {
  const root = makePlugin();
  try {
    const before = computeBuildHash(root);
    fs.writeFileSync(path.join(root, "dist", "index.js"), "// built v2 -- a real change");
    const after = computeBuildHash(root);
    assert.notEqual(before.hash, after.hash);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("touching a file without changing its content does not move the hash", () => {
  const root = makePlugin();
  try {
    const before = computeBuildHash(root);
    // Rewrite with identical bytes; only mtime changes.
    const p = path.join(root, "dist", "index.js");
    fs.writeFileSync(p, fs.readFileSync(p));
    const now = new Date(Date.now() + 60_000);
    fs.utimesSync(p, now, now);
    const after = computeBuildHash(root);
    assert.equal(before.hash, after.hash);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a file outside the deploy manifest does not affect the hash", () => {
  const root = makePlugin();
  try {
    const before = computeBuildHash(root);
    fs.writeFileSync(path.join(root, "README.md"), "# not shipped to the Deck");
    fs.writeFileSync(path.join(root, "notes.txt"), "scratch notes, also not shipped");
    const after = computeBuildHash(root);
    assert.equal(before.hash, after.hash, "only listDeploySources() entries should be fingerprinted");
    assert.deepEqual(after.inputs, before.inputs);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("inputs lists exactly the files that were hashed, relative and sorted", () => {
  const root = makePlugin();
  try {
    const { inputs } = computeBuildHash(root);
    assert.deepEqual(
      inputs.map((p) => p.split(path.sep).join("/")).sort(),
      ["dist/index.js", "main.py", "plugin.json"],
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a rewritten .pyc with no source change does not move the fingerprint", () => {
  /*
   * The bug the bonsAI plan-64 session hit on 2026-09-23. `py_modules` is in
   * DEPLOY_COPY_ENTRIES and this walk recurses, so every __pycache__ file was
   * fingerprinted -- and a .pyc embeds the source's mtime and size in its
   * header, so it is rewritten on every build even when the .py is byte
   * identical. The hash therefore moved on every build with no source change,
   * and a check saved before a deploy could never replay after one, which is
   * the only moment a replay is for.
   */
  const root = makePlugin();
  try {
    fs.mkdirSync(path.join(root, "py_modules", "__pycache__"), { recursive: true });
    fs.writeFileSync(path.join(root, "py_modules", "helper.py"), "X = 1");
    const pyc = path.join(root, "py_modules", "__pycache__", "helper.cpython-311.pyc");
    fs.writeFileSync(pyc, "PYC-WITH-MTIME-A");

    const before = computeBuildHash(root);
    assert.ok(
      !before.inputs.some((p) => p.includes("__pycache__")),
      `derived artifacts must not be fingerprinted: ${before.inputs.join(", ")}`,
    );
    assert.ok(
      before.inputs.some((p) => p.split(path.sep).join("/") === "py_modules/helper.py"),
      "the real source under py_modules must still be fingerprinted",
    );

    // Only the derived file changes, exactly as a rebuild does.
    fs.writeFileSync(pyc, "PYC-WITH-MTIME-B");
    assert.equal(computeBuildHash(root).hash, before.hash);

    // ...but a genuine source change still moves it.
    fs.writeFileSync(path.join(root, "py_modules", "helper.py"), "X = 2");
    assert.notEqual(computeBuildHash(root).hash, before.hash);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

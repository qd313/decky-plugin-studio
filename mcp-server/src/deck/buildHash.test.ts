/**
 * Tests for the cheap half of deck_checkReady: is the build on the Deck the
 * one we would actually ship?
 *
 * The SSH layer is faked exactly the way deckDeploy.test.ts fakes it --
 * `proc.execSync` (deploy/deployHelpers.ts's exec seam) is swapped out for the
 * duration of a case, so no ssh/scp process is ever spawned. Everything else
 * -- reading real fixture files off disk, hashing them, combining the
 * manifest -- runs for real, which is what lets a mismatch test change one
 * byte and see the compare actually notice.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  localBuildManifest,
  combineManifest,
  remoteHashCommand,
  parseHashOutput,
  verifyDeployedBuild,
} from "./buildHash.js";
import { proc } from "../deploy/deployHelpers.js";

function sha256(buf: Buffer | string): string {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function makeFixturePlugin(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dps-buildhash-"));
  fs.writeFileSync(path.join(root, "plugin.json"), JSON.stringify({ name: "bonsAI", version: "1.0.0" }));
  fs.mkdirSync(path.join(root, "dist"));
  fs.writeFileSync(path.join(root, "dist", "index.js"), "// built js\n");
  fs.mkdirSync(path.join(root, "dist", "assets"));
  fs.writeFileSync(path.join(root, "dist", "assets", "logo.svg"), "<svg></svg>");
  fs.writeFileSync(path.join(root, "main.py"), "# entry\n");
  return root;
}

/** `sha256sum`-shaped output for a manifest -- what a real Deck would print. */
function sha256sumOutput(entries: { path: string; sha256: string }[]): string {
  return entries.map((e) => `${e.sha256}  ${e.path}`).join("\n") + "\n";
}

/** Swaps the exec seam for the duration of `fn`, always restoring it after. */
async function withFakeExec<T>(impl: (cmd: string) => string, fn: () => Promise<T> | T): Promise<T> {
  const original = proc.execSync;
  proc.execSync = ((cmd: string) => impl(cmd)) as unknown as typeof proc.execSync;
  try {
    return await fn();
  } finally {
    proc.execSync = original;
  }
}

const roots: string[] = [];
after(() => {
  for (const r of roots) fs.rmSync(r, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// localBuildManifest / combineManifest
// ---------------------------------------------------------------------------

test("localBuildManifest hashes every file under every deploy source, sorted by path", () => {
  const root = makeFixturePlugin();
  roots.push(root);

  const manifest = localBuildManifest(root);
  const paths = manifest.map((e) => e.path);
  assert.deepEqual(
    [...paths].sort(),
    paths,
    "the manifest must already be sorted",
  );
  assert.deepEqual(
    paths.sort(),
    ["dist/assets/logo.svg", "dist/index.js", "main.py", "plugin.json"].sort(),
  );

  const indexEntry = manifest.find((e) => e.path === "dist/index.js")!;
  assert.equal(indexEntry.sha256, sha256("// built js\n"));
});

test("combineManifest is insensitive to input order but sensitive to content", () => {
  const a = [
    { path: "b.txt", sha256: sha256("b") },
    { path: "a.txt", sha256: sha256("a") },
  ];
  const shuffled = [a[1], a[0]];
  assert.equal(combineManifest(a), combineManifest(shuffled), "order must not matter");

  const changed = [
    { path: "a.txt", sha256: sha256("a") },
    { path: "b.txt", sha256: sha256("CHANGED") },
  ];
  assert.notEqual(combineManifest(a), combineManifest(changed), "a changed file must change the combined hash");
});

// ---------------------------------------------------------------------------
// remoteHashCommand / parseHashOutput
// ---------------------------------------------------------------------------

test("remoteHashCommand cds into the quoted target dir and finds only the given entries", () => {
  const cmd = remoteHashCommand("deck", "203.0.113.5", "~/homebrew/plugins/bonsAI", ["dist", "main.py", "plugin.json"]);
  assert.match(cmd, /^ssh .*deck@203\.0\.113\.5 "/);
  assert.match(cmd, /cd ~\/'homebrew\/plugins\/bonsAI' 2>\/dev\/null/);
  assert.match(cmd, /find dist main\.py plugin\.json -type f -exec sha256sum \{\} \+/);
});

test("parseHashOutput strips a leading ./ and ignores blank or garbage lines", () => {
  const h = sha256("x");
  const out = parseHashOutput(`\n${h}  ./dist/index.js\n\ngarbage line\n${h}  main.py\n`);
  assert.deepEqual(
    out.map((e) => e.path),
    ["dist/index.js", "main.py"],
  );
  assert.ok(out.every((e) => e.sha256 === h));
});

// ---------------------------------------------------------------------------
// verifyDeployedBuild
// ---------------------------------------------------------------------------

test("a build identical on both sides reports a match", async () => {
  const root = makeFixturePlugin();
  roots.push(root);
  const localManifest = localBuildManifest(root);

  const result = await withFakeExec(
    () => sha256sumOutput(localManifest),
    () => verifyDeployedBuild(root, "bonsAI", "deck", "203.0.113.5"),
  );

  assert.equal(result.matches, true, result.reason);
  assert.equal(result.localHash, result.remoteHash);
  assert.equal(result.localCount, localManifest.length);
  assert.equal(result.remoteCount, localManifest.length);
});

test("a single differing byte on the Deck is reported as a mismatch naming both hashes", async () => {
  const root = makeFixturePlugin();
  roots.push(root);
  const localManifest = localBuildManifest(root);
  const stale = localManifest.map((e) => (e.path === "main.py" ? { ...e, sha256: sha256("# STALE\n") } : e));

  const result = await withFakeExec(
    () => sha256sumOutput(stale),
    () => verifyDeployedBuild(root, "bonsAI", "deck", "203.0.113.5"),
  );

  assert.equal(result.matches, false);
  assert.notEqual(result.localHash, result.remoteHash);
  assert.match(result.reason ?? "", /redeploy/);
});

test("a file present locally but missing on the Deck is a mismatch, not a silent pass", async () => {
  const root = makeFixturePlugin();
  roots.push(root);
  const localManifest = localBuildManifest(root);
  const missingOneFile = localManifest.filter((e) => e.path !== "dist/assets/logo.svg");

  const result = await withFakeExec(
    () => sha256sumOutput(missingOneFile),
    () => verifyDeployedBuild(root, "bonsAI", "deck", "203.0.113.5"),
  );

  assert.equal(result.matches, false);
  assert.equal(result.remoteCount, localManifest.length - 1);
});

test("a plugin root that does not exist on disk has no deploy sources, and reports unknown rather than an empty match", () => {
  // listDeploySources()/listRootPythonHelpers() are written to degrade to "no
  // sources" rather than throw for a missing path (an existsSync guard, not a
  // read) -- so a nonexistent root and an empty one produce the same honest
  // "cannot verify" outcome, never a silent match.
  const result = verifyDeployedBuild(
    path.join(os.tmpdir(), "dps-buildhash-does-not-exist"),
    "bonsAI",
    "deck",
    "203.0.113.5",
  );
  assert.equal(result.matches, null);
  assert.match(result.reason ?? "", /no deploy sources found/);
});

test("no deploy sources at all reports unknown rather than an empty match", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dps-buildhash-empty-"));
  roots.push(root);
  const result = verifyDeployedBuild(root, "bonsAI", "deck", "203.0.113.5");
  assert.equal(result.matches, null);
  assert.match(result.reason ?? "", /no deploy sources found/);
});

test("a file that cannot be read while hashing reports unknown, never a silent match", () => {
  // Simulates a file that existed when listDeploySources() checked but cannot
  // actually be read (permissions, a race, a broken link) -- the one way
  // localBuildManifest() itself throws.
  const root = makeFixturePlugin();
  roots.push(root);
  const original = fs.readFileSync;
  (fs as unknown as { readFileSync: typeof fs.readFileSync }).readFileSync = (() => {
    throw new Error("EACCES: permission denied (simulated)");
  }) as typeof fs.readFileSync;
  let result;
  try {
    result = verifyDeployedBuild(root, "bonsAI", "deck", "203.0.113.5");
  } finally {
    (fs as unknown as { readFileSync: typeof fs.readFileSync }).readFileSync = original;
  }
  assert.equal(result.matches, null);
  assert.match(result.reason ?? "", /could not read the local build/);
});

test("an ssh failure with no readable output is unknown, not a false match or a false mismatch", async () => {
  const root = makeFixturePlugin();
  roots.push(root);

  const result = await withFakeExec(
    () => {
      throw Object.assign(new Error("Command failed"), { stdout: "", stderr: "ssh: connect to host port 22: Connection timed out" });
    },
    () => verifyDeployedBuild(root, "bonsAI", "deck", "203.0.113.5"),
  );

  assert.equal(result.matches, null, "an unreachable Deck must never read as a pass");
  assert.match(result.reason ?? "", /could not read the deployed build/);
});

test("a target directory that does not exist on the Deck is a confident non-match, not unknown", async () => {
  const root = makeFixturePlugin();
  roots.push(root);

  const result = await withFakeExec(
    () => {
      throw Object.assign(new Error("Command failed"), {
        stdout: "",
        stderr: "bash: line 1: cd: /home/deck/homebrew/plugins/bonsAI: No such file or directory",
      });
    },
    () => verifyDeployedBuild(root, "bonsAI", "deck", "203.0.113.5"),
  );

  assert.equal(result.matches, false, "a definitively-missing deploy is a finding, not a mystery");
  assert.match(result.reason ?? "", /has not been deployed/);
});

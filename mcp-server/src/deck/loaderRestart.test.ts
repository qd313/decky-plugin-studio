/**
 * Tests for the restart note as a file (plan 12 lane A).
 *
 * Found 2026-10-22: the note lived in one server process's memory, so a reload
 * done from the VS Code extension's server was invisible to an agent's server,
 * and that server's next deck_openPlugin read straight into the restart. The
 * note is now a file beside the lease file, written by a temp file and a
 * rename. The cross-process test below starts a real second node process that
 * writes the note, the way the extension's server would, and reads it here.
 *
 * Sandboxed: the config dir follows USERPROFILE/HOME (sandboxHome.ts).
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { sandboxHome } from "./__testutil__/sandboxHome.js";
import {
  noteLoaderRestart,
  msSinceLoaderRestart,
  clearLoaderRestart,
  loaderRestartNote,
  restartNotePath,
  RESTART_WINDOW_MS,
} from "./loaderRestart.js";
import { leaseDir, listLeases } from "./lease.js";

const home = sandboxHome("dps-restart-note-");
const here = path.dirname(fileURLToPath(import.meta.url));

beforeEach(() => {
  assert.ok(leaseDir().startsWith(home), `lease dir escaped the sandbox: ${leaseDir()}`);
  fs.rmSync(leaseDir(), { recursive: true, force: true });
});

/** Write a note the way another server process would: a file only, nothing in this process's memory. */
function foreignNote(machine: string, at: number, source = "deck_reloadPlugin"): void {
  fs.mkdirSync(leaseDir(), { recursive: true });
  fs.writeFileSync(
    restartNotePath(machine),
    JSON.stringify({ machine, at, atIso: new Date(at).toISOString(), source, pid: 999_999, host: "elsewhere" }),
  );
}

test("a note is a file beside the lease file, one per machine, and no temp file is left", () => {
  noteLoaderRestart("deck", Date.now(), "deck_reloadPlugin");
  noteLoaderRestart("this-pc", Date.now(), "deck_deploy");
  const names = fs.readdirSync(leaseDir()).sort();
  assert.deepEqual(names, ["deck.loader-restart", "this-pc.loader-restart"]);
  const note = JSON.parse(fs.readFileSync(restartNotePath("this-pc"), "utf8"));
  assert.equal(note.machine, "this-pc");
  assert.equal(note.source, "deck_deploy");
  assert.equal(note.pid, process.pid);
  clearLoaderRestart("deck");
  clearLoaderRestart("this-pc");
});

test("the note file is not read as a lease (listLeases reads every *.json in that directory)", () => {
  noteLoaderRestart("deck");
  assert.deepEqual(listLeases(), []);
  clearLoaderRestart("deck");
});

test("a note written only to the file -- another process's reload -- is seen here", () => {
  // The 2026-10-22 case: nothing in this process's memory says a restart happened.
  foreignNote("ext-reload", Date.now() - 1500);
  const age = msSinceLoaderRestart("ext-reload");
  assert.ok(age !== null && age >= 1500 && age < 6500, `age ${age}`);
  const note = loaderRestartNote("ext-reload");
  assert.equal(note?.fromFile, true);
  assert.equal(note?.pid, 999_999);
  clearLoaderRestart("ext-reload");
});

test("a real second node process writes the note and this one reads it", () => {
  const modUrl = pathToFileURL(path.join(here, "loaderRestart.ts")).href;
  const code =
    `const m = await import(${JSON.stringify(modUrl)}); ` +
    `m.noteLoaderRestart("child-proc", Date.now(), "deck_reloadPlugin"); console.log(process.pid);`;
  const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], {
    cwd: path.resolve(here, "..", ".."),
    env: { ...process.env, USERPROFILE: home, HOME: home },
    encoding: "utf8",
    timeout: 30_000,
  });
  assert.equal(child.status, 0, `child failed: ${child.stderr}`);
  const childPid = Number(child.stdout.trim());
  assert.ok(childPid > 0 && childPid !== process.pid);
  const age = msSinceLoaderRestart("child-proc");
  assert.ok(age !== null && age < RESTART_WINDOW_MS, "the other process's reload is seen by this one");
  assert.equal(loaderRestartNote("child-proc")?.pid, childPid);
  clearLoaderRestart("child-proc");
});

test("same 120 s window for a file note: older than the window reads as no note", () => {
  foreignNote("deck", Date.now() - RESTART_WINDOW_MS - 1000);
  assert.equal(msSinceLoaderRestart("deck"), null);
  foreignNote("deck", Date.now() + 60_000);
  assert.equal(msSinceLoaderRestart("deck"), null, "a note from the future is not a fresh restart");
});

test("clearing is for this process: its open tool stops waiting, the file stays for the others, a later note is seen", () => {
  noteLoaderRestart("deck", Date.now() - 5000);
  clearLoaderRestart("deck");
  assert.equal(msSinceLoaderRestart("deck"), null, "this process's next open does not wait for the Quick Access page again");
  assert.ok(fs.existsSync(restartNotePath("deck")), "another process has not seen the page: the file stays");

  // A clear covers every note it can see when it runs: its own and another
  // process's older one. "The page was readable after all of them."
  noteLoaderRestart("deck", Date.now() - 5000);
  foreignNote("deck", Date.now() - 100);
  const clearedAt = Date.now();
  clearLoaderRestart("deck");
  assert.equal(msSinceLoaderRestart("deck"), null);

  // Another process reloads after the clear: seen, even with this process's cache.
  foreignNote("deck", clearedAt + 1);
  assert.notEqual(msSinceLoaderRestart("deck"), null, "a note newer than the clear is seen");
  clearLoaderRestart("deck");
});

test("includeCleared: the rebuilding window runs its 120 s from the restart, cleared or not", () => {
  noteLoaderRestart("window", Date.now() - 3000);
  clearLoaderRestart("window");
  assert.equal(msSinceLoaderRestart("window"), null);
  const age = msSinceLoaderRestart("window", Date.now(), { includeCleared: true });
  assert.ok(age !== null && age >= 3000 && age < 8000, `age ${age}`);
  // Memory only (the file gone): the cleared time still answers.
  fs.rmSync(restartNotePath("window"), { force: true });
  assert.notEqual(msSinceLoaderRestart("window", Date.now(), { includeCleared: true }), null);
  // And it ends with the window.
  assert.equal(msSinceLoaderRestart("window", Date.now() + RESTART_WINDOW_MS, { includeCleared: true }), null);
});

test("a note this process writes after its own clear is seen at once", () => {
  noteLoaderRestart("deck");
  clearLoaderRestart("deck");
  assert.equal(msSinceLoaderRestart("deck"), null);
  noteLoaderRestart("deck");
  assert.notEqual(msSinceLoaderRestart("deck"), null);
  clearLoaderRestart("deck");
});

test("the memory cache answers when the file cannot be written", () => {
  // A FILE where the lease directory should be: mkdir and the write fail.
  fs.mkdirSync(path.dirname(leaseDir()), { recursive: true });
  fs.writeFileSync(leaseDir(), "not a directory");
  try {
    noteLoaderRestart("deck");
    const age = msSinceLoaderRestart("deck");
    assert.ok(age !== null && age < 5000, "the old one-process note still works");
    assert.equal(loaderRestartNote("deck")?.fromFile, false);
    clearLoaderRestart("deck");
    assert.equal(msSinceLoaderRestart("deck"), null);
  } finally {
    fs.rmSync(leaseDir(), { force: true });
  }
});

test("an unreadable note file is no note, not an error", () => {
  fs.mkdirSync(leaseDir(), { recursive: true });
  fs.writeFileSync(restartNotePath("deck"), "{ half a file");
  assert.equal(msSinceLoaderRestart("deck"), null);
});

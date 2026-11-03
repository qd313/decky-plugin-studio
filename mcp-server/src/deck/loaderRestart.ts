/**
 * How it works: remembers that a plugin_loader restart was just issued for a
 * machine, so a later deck_openPlugin knows the Deck's debugger may still be
 * rebuilding Steam's pages.
 *
 * The reload tool and the open tool are separate calls. After a deploy the
 * open tool is helped by the deploy waiting for the loader before it returns;
 * that wait only proves SOME Steam page is listed, not that the Quick Access
 * page is back and readable. After a reload that gap showed up on the Deck
 * (2026-09-26, 2026-10-01, 2026-10-11): the open tool failed twice and worked
 * on the third call. This note carries "a restart just happened" across the
 * two calls so the open tool can wait for the Quick Access page itself.
 *
 * A FILE PER MACHINE, NOT ONE PROCESS'S MEMORY (found 2026-10-22). There are
 * several server processes at any moment -- the extension's, each agent's --
 * and they share no memory. The note used to be a Map in this module, so a
 * reload done from the extension's tree was invisible to an agent's server,
 * whose next deck_openPlugin read straight into the restart. The note is now
 * written beside the lease file, `<config>/leases/<machine>.loader-restart`,
 * atomically (a temp file, then a rename, as lease.ts does), and every process
 * reads it. The Map stays as a cache, and as the fallback when the file cannot
 * be written or read: then the behaviour is the old one-process note, which
 * costs nothing worse than before.
 *
 * Not `<machine>.json`: lease.ts's listLeases() reads every *.json in that
 * directory as a lease.
 *
 * Both deck_reloadPlugin and deck_deploy write the note, right after the
 * restart is issued and before their loader wait.
 */
import fs from "fs";
import os from "os";
import path from "path";

import { currentMachineIfAny } from "../machines.js";
import { leaseDir } from "./lease.js";

/** How long after a restart the open tool still treats the Deck as rebuilding. */
export const RESTART_WINDOW_MS = 120_000;

/** What the note file holds. `at` is the clock of the process that wrote it; they all run on this host. */
export interface LoaderRestartNote {
  machine: string;
  /** Epoch ms when the restart was issued. */
  at: number;
  atIso: string;
  /** Which tool issued it: deck_reloadPlugin or deck_deploy ("unknown" in a hand-made file). */
  source: string;
  pid: number;
  host: string;
}

/** Newest restart this process knows of, per machine: its own notes, and file notes it has read. */
const restartedAt = new Map<string, number>();
/** Notes at or before this time were cleared by this process (the Quick Access page was seen readable since). */
const clearedUpTo = new Map<string, number>();

const keyOf = (machine?: string): string => machine ?? currentMachineIfAny()?.name ?? "default";

const safeName = (key: string): string => key.replace(/[^A-Za-z0-9._-]/g, "_");

const fileOf = (key: string): string => path.join(leaseDir(), `${safeName(key)}.loader-restart`);

/** Where the note for `machine` lives. Exported for tests and for deck_probeDebugger's evidence. */
export function restartNotePath(machine?: string): string {
  return fileOf(keyOf(machine));
}

function readNoteFile(key: string): LoaderRestartNote | null {
  let raw: string;
  try {
    raw = fs.readFileSync(fileOf(key), "utf8");
  } catch {
    return null;
  }
  try {
    const p = JSON.parse(raw) as Partial<LoaderRestartNote>;
    const at = Number(p.at);
    if (!Number.isFinite(at)) return null;
    return {
      machine: p.machine ?? key,
      at,
      atIso: p.atIso ?? new Date(at).toISOString(),
      source: p.source ?? "unknown",
      pid: Number(p.pid ?? 0),
      host: p.host ?? "unknown host",
    };
  } catch {
    // A rename cannot leave half a file, so this is a hand-edited one: no note.
    return null;
  }
}

function writeNoteFile(note: LoaderRestartNote): boolean {
  const dir = leaseDir();
  const tmp = path.join(dir, `.${safeName(note.machine)}.loader-restart.${process.pid}.${Date.now()}.tmp`);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(note, null, 2), "utf8");
    fs.renameSync(tmp, fileOf(note.machine));
    return true;
  } catch {
    // Same reason as lease.ts: a failed rename must not leave the temp file behind.
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* nothing more to do */
    }
    return false;
  }
}

/** The newest restart time known for `key`, from memory or file, before any clear is applied. */
function newestAt(key: string): number | undefined {
  const mem = restartedAt.get(key);
  const file = readNoteFile(key)?.at;
  if (file !== undefined && (mem === undefined || file > mem)) {
    restartedAt.set(key, file);
    return file;
  }
  return mem;
}

/**
 * Record that a loader restart was just issued: the file, and the cache.
 * Never throws. A note that could not be written leaves the cache, which is
 * the old behaviour, not an error for the reload that issued it.
 */
export function noteLoaderRestart(machine?: string, now: number = Date.now(), source = "deck_reloadPlugin"): void {
  const key = keyOf(machine);
  restartedAt.set(key, now);
  clearedUpTo.delete(key);
  writeNoteFile({
    machine: key,
    at: now,
    atIso: new Date(now).toISOString(),
    source,
    pid: process.pid,
    host: os.hostname(),
  });
}

/**
 * Milliseconds since the last noted restart, or null when none is recent.
 *
 * A note this process cleared (clearLoaderRestart) reads as null, unless
 * `includeCleared` is set: deck_openPlugin's rebuilding window runs its 120 s
 * from the restart whether or not the Quick Access page has answered once
 * since, because nothing says the debugger stops resetting after one answer.
 */
export function msSinceLoaderRestart(
  machine?: string,
  now: number = Date.now(),
  opts: { includeCleared?: boolean } = {},
): number | null {
  const key = keyOf(machine);
  let at = newestAt(key);
  const cleared = clearedUpTo.get(key);
  if (opts.includeCleared) {
    if (cleared !== undefined && (at === undefined || cleared > at)) at = cleared;
  } else if (at !== undefined && cleared !== undefined && at <= cleared) {
    return null;
  }
  if (at === undefined) return null;
  const age = now - at;
  return age >= 0 && age <= RESTART_WINDOW_MS ? age : null;
}

/**
 * The fresh note itself, for evidence files: who wrote it and whether it came
 * from the file. Null when none is fresh. A note this process cleared still
 * counts: this is about the restart, not about the wait for the page.
 */
export function loaderRestartNote(
  machine?: string,
  now: number = Date.now(),
): (LoaderRestartNote & { ageMs: number; fromFile: boolean }) | null {
  const key = keyOf(machine);
  const age = msSinceLoaderRestart(key, now, { includeCleared: true });
  if (age === null) return null;
  const at = now - age;
  const file = readNoteFile(key);
  if (file && file.at === at) return { ...file, ageMs: age, fromFile: true };
  return {
    machine: key,
    at,
    atIso: new Date(at).toISOString(),
    source: "this process (the file was not readable)",
    pid: process.pid,
    host: os.hostname(),
    ageMs: age,
    fromFile: false,
  };
}

/**
 * Forget the note, for this process: the Quick Access page has been seen
 * readable since, so this process's next deck_openPlugin need not wait for it
 * again. The file stays. Another process has not seen the page, so its open
 * tool still waits once (a wait that returns as soon as the page answers), and
 * the file runs out by itself when the 120 s window does. A note written after
 * the clear, by any process, is seen.
 */
export function clearLoaderRestart(machine?: string): void {
  const key = keyOf(machine);
  const at = newestAt(key);
  restartedAt.delete(key);
  if (at !== undefined) clearedUpTo.set(key, at);
}

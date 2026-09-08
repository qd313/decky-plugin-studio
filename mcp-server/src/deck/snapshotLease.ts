/**
 * Shared state machine behind deck_holdAwake / deck_restorePowerSettings and
 * deck_snapshotSettings / deck_restoreSettings.
 *
 * Both pairs are the same problem, twice: read a value off the Deck, write it
 * to a run file BEFORE touching anything, optionally push a different value in
 * its place, and later put the original back. Building that twice would drift
 * -- one pair getting the "refuse a second snapshot" check and the other not,
 * one expiring and the other not. This module is the one implementation;
 * deck/holdAwake.ts and deck/settingsSnapshot.ts are thin wrappers that supply
 * WHAT to read and HOW to push a value back, and this module owns the rest.
 *
 * THE BATTERY RISK THIS EXISTS FOR: a Deck with its screen/suspend timeouts
 * disabled, or its settings mid-swap, with nobody watching, drains itself.
 * Every rule below exists to fail towards the safe state -- sleep enabled,
 * settings restored -- rather than the unsafe one.
 *
 *   1. WRITE FIRST. takeSnapshot() reads the live value, persists it to disk,
 *      and only THEN applies a new value (when there is one to apply). A crash
 *      between those two steps is the difference between "the run file has the
 *      real original values, recoverable" and "the run file was never written
 *      and the original is gone" -- this module always does the write first,
 *      and does it as an atomic rename so a reader never sees a half file.
 *   2. REFUSE A SECOND SNAPSHOT while an earlier one sits unrestored. Silently
 *      overwriting it would either lose the FIRST original value (a second
 *      take() would capture the already-modified state as "original") or leave
 *      two changes in flight with only one recorded -- either way, restore()
 *      would put back the wrong thing.
 *   3. RESTORE IS IDEMPOTENT AND NEVER AN ERROR ON EMPTY. Absence of a run file
 *      means "nothing to put back" -- the normal end state after a successful
 *      restore -- and it must read as success, not as a missing-file error, or
 *      every restore-after-restore (or restore-when-nothing-ever-changed)
 *      sequence becomes a false alarm.
 *   4. EXPIRE TOWARDS SAFE. Every takeSnapshot() call checks the OLD
 *      snapshot's expiry first and auto-restores it before doing anything else
 *      if the lease has run out. A forgotten restore then costs, at worst,
 *      until the next takeSnapshot() call for that same kind -- not forever.
 *      See the note on takeSnapshot() for why this is lazy rather than a
 *      background timer.
 *   5. A RUN FILE THAT DOES NOT PARSE, OR PARSES BUT DOES NOT CHECK OUT AGAINST
 *      ITS OWN RECORDED CHECKSUM, IS NEVER TRUSTED. Both takeSnapshot() and
 *      restoreSnapshot() throw CorruptSnapshotError rather than treating it as
 *      absent (which would let a real unrestored change slip through
 *      unnoticed) or as trustworthy (which would restore, or refuse to
 *      overwrite, based on values nobody can vouch for).
 */
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";

import { getConfigDir } from "../config.js";

/** Chosen to comfortably cover a QA run with several questions and a game
 * launch/exit (the acceptance case in the roadmap is "20+ minutes unattended")
 * while bounding the worst case -- a forgotten restore -- to well under an
 * hour of extra drain. Overridable per snapshot kind and per call. */
export const DEFAULT_SNAPSHOT_TTL_MINUTES = 30;

export interface SnapshotEnvelope<T> {
  kind: string;
  takenAt: string;
  expiresAt: string;
  pid: number;
  host: string;
  note?: string;
  values: T;
  /** sha256 of kind|takenAt|JSON(values), truncated. Recomputed on every read;
   * a mismatch means the file was only partially written, or hand-edited. */
  sig: string;
}

export interface SnapshotOptions {
  note?: string;
  /** Injectable clock so expiry is testable without a real wait. */
  now?: () => number;
}

function snapshotDir(): string {
  return path.join(getConfigDir(), "snapshots");
}

export function snapshotPath(kind: string): string {
  return path.join(snapshotDir(), `${kind}.json`);
}

/**
 * A run file is present but cannot be trusted: bad JSON, a missing field, or a
 * checksum that does not match its own contents. This is deliberately not the
 * same outcome as "no snapshot" -- callers must not silently proceed as though
 * nothing were pending, because something plainly was.
 */
export class CorruptSnapshotError extends Error {
  constructor(
    public readonly kind: string,
    public readonly filePath: string,
    detail: string
  ) {
    super(
      `The ${kind} run file at ${filePath} could not be trusted (${detail}). It is not being ` +
        "treated as empty or as valid -- check by hand whether the Deck still needs restoring " +
        "before deleting it, then retry."
    );
    this.name = "CorruptSnapshotError";
  }
}

/** A live, unrestored snapshot already exists. Names it and how to clear it. */
export class StaleSnapshotError extends Error {
  constructor(
    public readonly envelope: SnapshotEnvelope<unknown>,
    public readonly filePath: string,
    restoreToolHint: string
  ) {
    super(
      `A ${envelope.kind} snapshot taken at ${envelope.takenAt} was never restored (run file: ` +
        `${filePath}). Call ${restoreToolHint} first -- it is safe to call even if you are not ` +
        `sure anything changed. Left alone, it restores itself automatically at ` +
        `${envelope.expiresAt}.`
    );
    this.name = "StaleSnapshotError";
  }
}

function computeSig(kind: string, takenAt: string, values: unknown): string {
  return crypto
    .createHash("sha256")
    .update(`${kind}|${takenAt}|${JSON.stringify(values)}`)
    .digest("hex")
    .slice(0, 32);
}

const REQUIRED_FIELDS = ["kind", "takenAt", "expiresAt", "pid", "host", "values", "sig"] as const;

/**
 * Read and verify the run file for `kind`. `null` means genuinely absent --
 * nothing has ever been snapshotted, or the last restore cleaned up after
 * itself. Anything present but unverifiable THROWS rather than returning
 * null, so a caller can never mistake "corrupt" for "nothing to worry about".
 */
export function readSnapshotFile<T>(kind: string): SnapshotEnvelope<T> | null {
  const file = snapshotPath(kind);
  if (!fs.existsSync(file)) return null;

  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (err) {
    throw new CorruptSnapshotError(kind, file, `unreadable: ${(err as Error).message}`);
  }

  let parsed: Partial<SnapshotEnvelope<T>>;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CorruptSnapshotError(kind, file, "not valid JSON -- likely a partial write");
  }

  for (const field of REQUIRED_FIELDS) {
    if (!(field in parsed)) {
      throw new CorruptSnapshotError(kind, file, `missing "${field}" -- likely a partial write`);
    }
  }

  const expectedSig = computeSig(String(parsed.kind), String(parsed.takenAt), parsed.values);
  if (parsed.sig !== expectedSig) {
    throw new CorruptSnapshotError(kind, file, "checksum does not match its own contents");
  }

  return parsed as SnapshotEnvelope<T>;
}

/**
 * Persist `values` BEFORE anything is changed. Writes to a sibling temp file
 * and renames over the target, so a reader never observes a half-written file
 * -- the rename is the only thing that makes it appear at all.
 */
export function writeSnapshotFile<T>(
  kind: string,
  values: T,
  ttlMinutes: number,
  opts: SnapshotOptions = {}
): SnapshotEnvelope<T> {
  const now = opts.now ?? Date.now;
  const takenAt = new Date(now()).toISOString();
  const expiresAt = new Date(now() + ttlMinutes * 60_000).toISOString();
  const envelope: SnapshotEnvelope<T> = {
    kind,
    takenAt,
    expiresAt,
    pid: process.pid,
    host: os.hostname(),
    note: opts.note,
    values,
    sig: computeSig(kind, takenAt, values),
  };

  const dir = snapshotDir();
  fs.mkdirSync(dir, { recursive: true });
  const file = snapshotPath(kind);
  const tmp = path.join(dir, `.${kind}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(envelope, null, 2), "utf8");
  fs.renameSync(tmp, file);
  return envelope;
}

export function clearSnapshotFile(kind: string): void {
  fs.rmSync(snapshotPath(kind), { force: true });
}

export function isExpired<T>(envelope: SnapshotEnvelope<T>, now: () => number = Date.now): boolean {
  const expiry = Date.parse(envelope.expiresAt);
  return Number.isFinite(expiry) && now() >= expiry;
}

/**
 * What a feature (deck/holdAwake.ts, deck/settingsSnapshot.ts) supplies. This
 * module owns the run-file bookkeeping and the refuse/expire/restore rules;
 * the feature owns talking to the Deck.
 */
export interface SnapshotController<T> {
  /** Run-file name and the identity of this kind of snapshot, e.g. "power-hold". */
  kind: string;
  /** Tool name to name in a stale/refusal message, e.g. "deck_restorePowerSettings". */
  restoreToolHint: string;
  ttlMinutes: number;
  /** Read the CURRENT live value. Called once per takeSnapshot(), before
   * anything changes. */
  readCurrent(): Promise<T> | T;
  /** Push `values` onto the Deck. Used both for a real restore and for the
   * auto-restore of an expired snapshot. */
  apply(values: T): Promise<void> | void;
}

export interface TakeReport<T> {
  ok: true;
  taken: true;
  previous: T;
  /** The value actually applied, when `applyNew` was given. `null` for a
   * snapshot-only controller (nothing changes at take time -- see
   * deck/settingsSnapshot.ts). */
  changed: T | null;
  path: string;
  expiresAt: string;
  /** Set when an EARLIER snapshot of this kind had already expired and was
   * auto-restored before this new one was taken. */
  autoRestoredExpired: { at: string; values: T } | null;
}

/**
 * Capture the current value, persist it, then (optionally) push a new value.
 *
 * Order matters and is the entire point of this function: `readCurrent()` and
 * the run-file write both happen before `applyNew`/`apply` are ever called. A
 * crash after the file is written and before -- or during -- the apply step
 * leaves a recoverable run file and a Deck that is either still in its
 * original state or in the new one; either way restoreSnapshot() can put it
 * back, because it always pushes what the file says regardless of what
 * actually landed.
 *
 * NO BACKGROUND TIMER. Expiry is enforced lazily, here and nowhere else: the
 * OLD snapshot's expiry is checked, and if it has passed, auto-restored before
 * this call does anything else. A session that calls neither takeSnapshot()
 * nor restoreSnapshot() again for this kind will not self-heal on a wall
 * clock -- it heals the next time either is called. That is a deliberate
 * trade against an in-process setTimeout, which cannot survive this server
 * being restarted anyway (the crash case this whole module exists for), so a
 * timer would add complexity without adding the one guarantee that matters.
 * See this lane's report for the honest cost of that trade.
 */
export async function takeSnapshot<T>(
  ctrl: SnapshotController<T>,
  applyNew?: (previous: T) => Promise<T> | T,
  opts: SnapshotOptions = {}
): Promise<TakeReport<T>> {
  const now = opts.now ?? Date.now;
  const existing = readSnapshotFile<T>(ctrl.kind); // throws CorruptSnapshotError

  let autoRestoredExpired: TakeReport<T>["autoRestoredExpired"] = null;
  if (existing) {
    if (isExpired(existing, now)) {
      await ctrl.apply(existing.values);
      clearSnapshotFile(ctrl.kind);
      autoRestoredExpired = { at: existing.expiresAt, values: existing.values };
    } else {
      throw new StaleSnapshotError(existing, snapshotPath(ctrl.kind), ctrl.restoreToolHint);
    }
  }

  const previous = await ctrl.readCurrent();
  const envelope = writeSnapshotFile(ctrl.kind, previous, ctrl.ttlMinutes, {
    note: opts.note,
    now,
  });

  let changed: T | null = null;
  if (applyNew) {
    changed = await applyNew(previous);
    await ctrl.apply(changed);
  }

  return {
    ok: true,
    taken: true,
    previous,
    changed,
    path: snapshotPath(ctrl.kind),
    expiresAt: envelope.expiresAt,
    autoRestoredExpired,
  };
}

export interface RestoreReport<T> {
  ok: true;
  restored: boolean;
  values: T | null;
  note: string;
}

/**
 * Put the snapshotted value back. Safe with nothing to restore (a clean
 * no-op, not an error) and safe to call twice -- the second call finds no run
 * file and takes the same no-op path as if nothing had ever been snapshotted.
 */
export async function restoreSnapshot<T>(ctrl: SnapshotController<T>): Promise<RestoreReport<T>> {
  const existing = readSnapshotFile<T>(ctrl.kind); // throws CorruptSnapshotError
  if (!existing) {
    return {
      ok: true,
      restored: false,
      values: null,
      note: `no ${ctrl.kind} snapshot present -- nothing to restore`,
    };
  }
  await ctrl.apply(existing.values);
  clearSnapshotFile(ctrl.kind);
  return {
    ok: true,
    restored: true,
    values: existing.values,
    note: `restored the ${ctrl.kind} values captured at ${existing.takenAt}`,
  };
}

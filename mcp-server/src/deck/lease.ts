/**
 * Only one driver at a time -- a per-machine lease (ROADMAP, Planned; plan 10 § 5 item 1).
 *
 * bonsAI's plan 31 said it plainly: two chat sessions drove the same Deck in
 * one evening, one pinned chips the other had to restore, and nothing in this
 * server could have told either of them the other was there. The killswitch
 * registers tunnels, not presses, and a tunnel is not a driver.
 *
 * The lease is a FILE per machine in the config directory, for the same
 * reason the killswitch latch is a file: there are several server processes
 * at any moment (the extension's, each agent's) and they share no memory.
 *
 *   - ACQUIRED IMPLICITLY by the first driving call (a press, a deploy, a
 *     reload, a sweep...), at the dispatch seam in index.ts, and RENEWED by
 *     every later one. A session never has to remember to take it, so it
 *     cannot forget to.
 *   - REFUSED, with the holder named, when another live process holds it.
 *     The refusal says who, since when, for what, and how to take over. It
 *     does not queue and it does not wait: the second session should stop and
 *     talk to a human, not press the moment the first one pauses.
 *   - EXPIRES. The heartbeat is refreshed on every call and every 30 s during
 *     a long one; a lease nobody has touched for `ttlMs` (default 10 minutes)
 *     is free, and so is one whose owner pid is dead on this host. A crashed
 *     session therefore blocks nobody for long, and never forever.
 *   - RELEASED on process exit (index.ts), or by deck_releaseMachine. The
 *     owner releases its own; `force: true` evicts another holder and says so
 *     in the result -- the evicted session's next driving call refuses with
 *     "you no longer hold the lease", which is the honest outcome.
 *
 * What it is NOT: a safety device. The killswitch is the safety device. The
 * lease is coordination, so a second session gets a clear answer instead of a
 * mystery, and so the extension's 30 s status poll can stay off a serial port
 * that a leased run is using (ROADMAP: "status poll opens COM7").
 */
import fs from "fs";
import os from "os";
import path from "path";

import { ensureConfigDir, getConfigDir } from "../config.js";

export const DEFAULT_LEASE_TTL_MS = 10 * 60_000;
export const LEASE_HEARTBEAT_MS = 30_000;

export interface LeaseRecord {
  machine: string;
  ownerPid: number;
  ownerHost: string;
  /** Human-readable owner, from DPS_SESSION_LABEL when set, else "pid N on host". */
  owner: string;
  /** What the holder is doing: the last driving tool's name, or a caller-supplied purpose. */
  purpose: string;
  since: string;
  heartbeatAt: string;
  expiresAt: string;
}

export type AcquireResult =
  | { ok: true; lease: LeaseRecord; renewed: boolean; tookOverFrom: LeaseRecord | null }
  | { ok: false; holder: LeaseRecord; reason: string };

export interface LeaseOptions {
  purpose?: string;
  ttlMs?: number;
  /** Injectable clock so expiry is testable without a real wait. */
  now?: () => number;
  /** Injectable liveness probe, for tests. Default: process.kill(pid, 0) on this host. */
  pidAlive?: (pid: number) => boolean;
}

function leaseDir(): string {
  return path.join(getConfigDir(), "leases");
}

export function leasePath(machine: string): string {
  return path.join(leaseDir(), `${machine}.json`);
}

function ownerLabel(): string {
  const label = process.env.DPS_SESSION_LABEL?.trim();
  return label ? `${label} (pid ${process.pid} on ${os.hostname()})` : `pid ${process.pid} on ${os.hostname()}`;
}

function defaultPidAlive(pid: number): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The lease file for `machine`, or null. A present-but-unreadable file counts as held by an unknown owner. */
export function readLease(machine: string): LeaseRecord | null {
  const file = leasePath(machine);
  let raw: string;
  try {
    if (!fs.existsSync(file)) return null;
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
  try {
    const p = JSON.parse(raw) as Partial<LeaseRecord>;
    return {
      machine: p.machine ?? machine,
      ownerPid: Number(p.ownerPid ?? 0),
      ownerHost: p.ownerHost ?? "unknown host",
      owner: p.owner ?? "unknown",
      purpose: p.purpose ?? "unknown",
      since: p.since ?? "unknown time",
      heartbeatAt: p.heartbeatAt ?? p.since ?? "unknown time",
      expiresAt: p.expiresAt ?? "unknown time",
    };
  } catch {
    // Caught mid-write or hand-edited. Treat as held: expiry (below) frees it
    // soon enough, and an unparseable expiry reads as "already expired".
    return {
      machine,
      ownerPid: 0,
      ownerHost: "unknown host",
      owner: "unknown (unreadable lease file)",
      purpose: "unknown",
      since: "unknown time",
      heartbeatAt: "unknown time",
      expiresAt: "unknown time",
    };
  }
}

function writeLease(rec: LeaseRecord): void {
  ensureConfigDir();
  fs.mkdirSync(leaseDir(), { recursive: true });
  const file = leasePath(rec.machine);
  const tmp = path.join(leaseDir(), `.${rec.machine}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(rec, null, 2), "utf8");
  fs.renameSync(tmp, file);
}

function isMine(rec: LeaseRecord): boolean {
  return rec.ownerPid === process.pid && rec.ownerHost === os.hostname();
}

/**
 * Is this lease still binding on another process? Expired, or owned by a
 * dead pid on this host, means no. An unparseable expiry means no as well:
 * a lease whose own record cannot say when it ends does not get to hold
 * anyone up indefinitely.
 */
export function leaseIsLive(rec: LeaseRecord, opts: LeaseOptions = {}): boolean {
  const now = (opts.now ?? Date.now)();
  const expiry = Date.parse(rec.expiresAt);
  if (!Number.isFinite(expiry) || now >= expiry) return false;
  if (rec.ownerHost === os.hostname()) {
    const alive = opts.pidAlive ?? defaultPidAlive;
    if (!alive(rec.ownerPid)) return false;
  }
  return true;
}

/** A live lease held by someone other than this process, or null. The status poll asks this. */
export function leaseHeldByOther(machine: string, opts: LeaseOptions = {}): LeaseRecord | null {
  const rec = readLease(machine);
  if (!rec || isMine(rec)) return null;
  return leaseIsLive(rec, opts) ? rec : null;
}

/** Does this process currently hold a live lease on `machine`? */
export function leaseHeldByMe(machine: string, opts: LeaseOptions = {}): boolean {
  const rec = readLease(machine);
  return Boolean(rec && isMine(rec) && leaseIsLive(rec, opts));
}

export function refusalMessage(holder: LeaseRecord): string {
  return (
    `Machine "${holder.machine}" is being driven by another session: ${holder.owner}, since ${holder.since}, ` +
    `purpose "${holder.purpose}", last heartbeat ${holder.heartbeatAt}. Only one driver at a time. ` +
    `Do not look for another way to press -- stop and tell the user. If that session is known to be gone, ` +
    `the lease frees itself at ${holder.expiresAt}, or deck_releaseMachine({ machine: "${holder.machine}", force: true }) evicts it now.`
  );
}

export class LeaseRefusedError extends Error {
  constructor(public readonly holder: LeaseRecord) {
    super(refusalMessage(holder));
    this.name = "LeaseRefusedError";
  }
}

/**
 * Take or renew the lease on `machine` for this process.
 *
 * Never throws. A refusal is a return value so the seam can decide how to
 * report it (as a tool error with the holder named) and so callers that only
 * want to know (deck_status) can ask without a try/catch.
 */
export function acquireLease(machine: string, opts: LeaseOptions = {}): AcquireResult {
  const now = opts.now ?? Date.now;
  const ttlMs = Math.max(1_000, opts.ttlMs ?? DEFAULT_LEASE_TTL_MS);
  const existing = readLease(machine);
  const t = now();

  let tookOverFrom: LeaseRecord | null = null;
  let since = new Date(t).toISOString();
  let renewed = false;

  if (existing) {
    if (isMine(existing)) {
      since = existing.since;
      renewed = true;
    } else if (leaseIsLive(existing, { ...opts, now })) {
      return { ok: false, holder: existing, reason: refusalMessage(existing) };
    } else {
      tookOverFrom = existing;
    }
  }

  const rec: LeaseRecord = {
    machine,
    ownerPid: process.pid,
    ownerHost: os.hostname(),
    owner: ownerLabel(),
    purpose: opts.purpose?.trim() || (renewed ? existing!.purpose : "unspecified"),
    since,
    heartbeatAt: new Date(t).toISOString(),
    expiresAt: new Date(t + ttlMs).toISOString(),
  };
  try {
    writeLease(rec);
  } catch (err) {
    // If the file cannot be written nobody else can see our claim, and a
    // claim nobody can see is not a lease. Refuse rather than drive unseen.
    return {
      ok: false,
      holder: rec,
      reason: `the lease file for "${machine}" could not be written (${(err as Error).message}); refusing to drive without a visible lease`,
    };
  }
  return { ok: true, lease: rec, renewed, tookOverFrom };
}

/** Refresh the heartbeat on a lease this process holds. A no-op when it does not. */
export function renewLease(machine: string, opts: LeaseOptions = {}): boolean {
  const rec = readLease(machine);
  if (!rec || !isMine(rec)) return false;
  const r = acquireLease(machine, { ...opts, purpose: rec.purpose });
  return r.ok;
}

export interface ReleaseResult {
  released: boolean;
  /** The lease that was there before, if any. */
  was: LeaseRecord | null;
  forced: boolean;
  note: string;
}

/**
 * Release the lease on `machine`. The owner may always release its own; a
 * lease that is already dead (expired, owner gone) is simply removed; a live
 * lease held by someone else needs `force`, and the result says it was forced.
 */
export function releaseLease(machine: string, opts: LeaseOptions & { force?: boolean } = {}): ReleaseResult {
  const rec = readLease(machine);
  if (!rec) return { released: false, was: null, forced: false, note: `no lease on "${machine}"` };
  const mine = isMine(rec);
  const live = leaseIsLive(rec, opts);
  if (!mine && live && !opts.force) {
    return {
      released: false,
      was: rec,
      forced: false,
      note: `"${machine}" is leased by ${rec.owner} (purpose "${rec.purpose}", until ${rec.expiresAt}); pass force: true to evict`,
    };
  }
  try {
    fs.rmSync(leasePath(machine), { force: true });
  } catch (err) {
    return { released: false, was: rec, forced: false, note: `could not remove the lease file: ${(err as Error).message}` };
  }
  const forced = !mine && live;
  return {
    released: true,
    was: rec,
    forced,
    note: forced
      ? `evicted ${rec.owner} from "${machine}" -- their next driving call will refuse`
      : mine
        ? `released this session's lease on "${machine}"`
        : `removed a dead lease on "${machine}" (${rec.owner}, expired or owner gone)`,
  };
}

/** Every lease file, live or not, for deck_listMachines and deck_status. */
export function listLeases(opts: LeaseOptions = {}): Array<LeaseRecord & { live: boolean; mine: boolean }> {
  let names: string[];
  try {
    names = fs.readdirSync(leaseDir());
  } catch {
    return [];
  }
  const out: Array<LeaseRecord & { live: boolean; mine: boolean }> = [];
  for (const n of names) {
    if (!n.endsWith(".json")) continue;
    const rec = readLease(n.slice(0, -".json".length));
    if (rec) out.push({ ...rec, live: leaseIsLive(rec, opts), mine: isMine(rec) });
  }
  return out;
}

/** On process exit: drop every lease this process holds. Nothing else is touched. */
export function releaseLeasesHeldByThisProcess(): string[] {
  const released: string[] = [];
  for (const l of listLeases()) {
    if (l.mine) {
      try {
        fs.rmSync(leasePath(l.machine), { force: true });
        released.push(l.machine);
      } catch {
        /* nothing useful to do on the way out */
      }
    }
  }
  return released;
}

/**
 * Run `fn` holding the lease on `machine`, renewing the heartbeat every 30 s
 * while it runs. Throws LeaseRefusedError before `fn` starts if another live
 * holder exists. The lease is KEPT after `fn` returns -- it belongs to the
 * session, not the call; release is explicit or by exit/expiry.
 */
export async function withLease<T>(machine: string, purpose: string, fn: () => Promise<T>, opts: LeaseOptions = {}): Promise<T> {
  const got = acquireLease(machine, { ...opts, purpose });
  if (!got.ok) throw new LeaseRefusedError(got.holder);
  const beat = setInterval(() => {
    renewLease(machine, opts);
  }, LEASE_HEARTBEAT_MS);
  beat.unref?.();
  try {
    return await fn();
  } finally {
    clearInterval(beat);
    renewLease(machine, opts);
  }
}

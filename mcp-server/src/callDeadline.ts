/**
 * Calls that cannot hang, and a server that cannot die quietly (plan 11, lane D).
 *
 * From bonsAI's device log: one deck_walkTo hung for 35 minutes and returned
 * nothing (2026-09-26); a tool stalled about 29 minutes "with no press sent and
 * no error surfaced until the next call" (2026-09-26); and three times the
 * server's tool connection closed mid-call because one stray rejection ended
 * the process (2026-09-19, 2026-10-22 twice).
 *
 * This module is the guard index.ts wraps around every `tools/*` call:
 *
 *   - A wall-clock DEADLINE per call (defaults below; any call may pass
 *     `deadlineMs`). When it passes, the call returns an honest error naming
 *     the tool, the deadline and the last stage the tool reported; its lease
 *     heartbeat stops; child processes it spawned are killed; and on a driving
 *     tool the pad is released through the same release path
 *     deck_stopAutomation uses -- WITHOUT setting the stop latch, because a
 *     timeout is not a stop.
 *   - One driving call at a time per machine (callQueue.ts), waited for in
 *     line and counted against the waiting call's own deadline.
 *   - Process-level handlers so a stray rejection or exception is logged with
 *     the tool in flight and the process stays up.
 */
import { AsyncLocalStorage } from "async_hooks";
import type { ChildProcess } from "child_process";
import { createRequire, syncBuiltinESMExports } from "module";
import { MachineCallQueue, QueueSlot } from "./callQueue.js";

// ---------------------------------------------------------------------------
// Deadlines
// ---------------------------------------------------------------------------

/**
 * driving: walk, sweep, sequence, open, launch, exit, deploy, snapshot,
 *          record... -- anything that takes the machine's lease.
 * read:    every other tool.
 * status:  deck_status and the registry/killswitch tools, which must answer
 *          fast or not at all.
 */
export type CallClass = "driving" | "read" | "status";

export const DEFAULT_DEADLINE_MS: Readonly<Record<CallClass, number>> = {
  driving: 10 * 60_000,
  read: 60_000,
  status: 30_000,
};

/**
 * Pull `deadlineMs` out of a call's arguments. It is the seam's argument, not
 * the tool's: several tools hand their whole params object on (deck_configure
 * writes it into deck.env), so it must never reach them.
 */
export function takeDeadlineArg(
  params: Record<string, unknown>,
  cls: CallClass,
): { deadlineMs: number; source: "default" | "requested"; rest: Record<string, unknown> } {
  if (!Object.prototype.hasOwnProperty.call(params, "deadlineMs")) {
    return { deadlineMs: DEFAULT_DEADLINE_MS[cls], source: "default", rest: params };
  }
  const { deadlineMs: raw, ...rest } = params;
  if (raw == null) return { deadlineMs: DEFAULT_DEADLINE_MS[cls], source: "default", rest };
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(
      `deadlineMs must be a positive number of milliseconds; got ${JSON.stringify(raw)}. ` +
        `Omit it to use the default (${DEFAULT_DEADLINE_MS[cls]} ms for this tool).`,
    );
  }
  return { deadlineMs: Math.floor(n), source: "requested", rest };
}

// ---------------------------------------------------------------------------
// The call in flight
// ---------------------------------------------------------------------------

export interface CallContext {
  tool: string;
  machine: string | null;
  startedAt: number;
  /** The last stage the tool reported through reportCallStage(), if any. */
  stage: string | null;
  /** Child processes this call spawned that are still running. */
  children: Set<ChildProcess>;
}

const callContext = new AsyncLocalStorage<CallContext>();
const inFlight = new Set<CallContext>();

/**
 * A tool may call this as it moves through its stages ("open QAM", "rail",
 * "press A"...), so a call that runs out of time can say where it was. No
 * tool module does yet; until one does, a timed-out call says it reports no
 * stages. A no-op outside a guarded call.
 */
export function reportCallStage(stage: string): void {
  const ctx = callContext.getStore();
  if (ctx) ctx.stage = stage;
}

/** The tools in flight right now, for a crash log line. */
export function describeInFlight(): string {
  const now = Date.now();
  const names = [...inFlight].map(
    (c) => `${c.tool}${c.machine ? ` on "${c.machine}"` : ""} (${now - c.startedAt} ms${c.stage ? `, stage "${c.stage}"` : ""})`,
  );
  return names.length ? names.join(", ") : "none";
}

// ---------------------------------------------------------------------------
// Child processes
// ---------------------------------------------------------------------------

const require = createRequire(import.meta.url);
let childTrackingInstalled = false;

/**
 * Wrap child_process.spawn so a child spawned inside a guarded call is
 * recorded on that call, and a call that runs out of time can kill what it
 * started. syncBuiltinESMExports() pushes the wrapper into the live ESM
 * bindings every tool module imports (`import { spawn } from "child_process"`).
 *
 * Deliberately NOT covered: execSync/spawnSync (they block the event loop, so
 * no deadline timer can fire while they run at all), exec/execFile (Node
 * routes them to its internal spawn), and a module that captured the original
 * function by value before this ran -- cdpTunnel.ts's `proc.spawn`, which is
 * also why the shared CDP tunnel, meant to outlive every call, is not killed.
 */
export function installChildTracking(): void {
  if (childTrackingInstalled) return;
  childTrackingInstalled = true;
  const cp = require("child_process") as typeof import("child_process");
  const original = cp.spawn;
  const tracked = function (this: unknown, ...args: unknown[]): ChildProcess {
    const child = (original as (...a: unknown[]) => ChildProcess).apply(this, args);
    const ctx = callContext.getStore();
    if (ctx && child) {
      ctx.children.add(child);
      const forget = (): void => {
        ctx.children.delete(child);
      };
      child.once("exit", forget);
      child.once("error", forget);
    }
    return child;
  };
  (cp as unknown as Record<string, unknown>).spawn = tracked;
  syncBuiltinESMExports();
}

/**
 * Kill what a call started: the whole tree on Windows (taskkill /T), the
 * process group on POSIX when the child leads one, else the child alone.
 */
export function killCallChildren(ctx: CallContext): string[] {
  const killed: string[] = [];
  for (const child of ctx.children) {
    if (child.exitCode != null || child.signalCode != null || child.pid == null) continue;
    const label = `${child.spawnfile} pid ${child.pid}`;
    try {
      if (process.platform === "win32") {
        const cp = require("child_process") as typeof import("child_process");
        const r = cp.spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
          timeout: 5000,
          windowsHide: true,
          stdio: "ignore",
        });
        if (r.status !== 0) child.kill("SIGKILL");
      } else {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      }
      killed.push(label);
    } catch (e) {
      killed.push(`${label} (kill failed: ${(e as Error).message})`);
    }
  }
  ctx.children.clear();
  return killed;
}

// ---------------------------------------------------------------------------
// The error a timed-out call returns
// ---------------------------------------------------------------------------

/** Same shape as killswitch.ts ReleaseReport. */
export interface PadRelease {
  attempted: boolean;
  ok: boolean;
  detail: string;
}

export class CallDeadlineError extends Error {
  constructor(
    readonly tool: string,
    readonly deadlineMs: number,
    readonly deadlineSource: "default" | "requested",
    readonly cls: CallClass,
    readonly lastStage: string | null,
    readonly killedChildren: string[],
    readonly release: PadRelease | null,
  ) {
    const why =
      deadlineSource === "requested"
        ? "the deadlineMs this call passed"
        : `the default for ${cls} tools; pass deadlineMs to change it`;
    const parts = [
      `${tool} did not finish within its deadline of ${deadlineMs} ms (${why}).`,
      lastStage
        ? `The last stage it reported was "${lastStage}".`
        : "It reports no stages, so there is no last stage to name.",
      "The call was abandoned, not cancelled: whatever it was waiting on may still finish " +
        "inside this server, and its result will be thrown away.",
      killedChildren.length
        ? `Child processes it had started were killed: ${killedChildren.join(", ")}.`
        : "It had no child process still running.",
      release
        ? `Pad release (the same path deck_stopAutomation uses; the stop latch was NOT set): ` +
          `${release.ok ? "done" : release.attempted ? "sent but not confirmed" : "not sent"} -- ${release.detail}`
        : "It is not a driving tool, so no pad release was needed.",
      release
        ? "Its lease heartbeat has stopped. Read the machine's state (deck_readFocus or " +
          "deck_captureScreenshot) before driving it again."
        : "",
    ];
    super(parts.filter(Boolean).join(" "));
    this.name = "CallDeadlineError";
  }
}

// ---------------------------------------------------------------------------
// The guard
// ---------------------------------------------------------------------------

export interface GuardSpec<T> {
  tool: string;
  /** The resolved machine's name; null for a tool that is not about a machine. */
  machine: string | null;
  cls: CallClass;
  deadlineMs: number;
  deadlineSource?: "default" | "requested";
  /** Driving calls only: the per-machine queue. Reads never queue. */
  queue?: MachineCallQueue;
  /** The tool itself. */
  run: () => Promise<T>;
  /**
   * Wraps the run -- the lease (deck/lease.ts withLease). The deadline races
   * INSIDE it, so when the deadline fires withLease's own `finally` stops the
   * heartbeat even though the tool's promise never settles.
   */
  around?: (fn: () => Promise<T>) => Promise<T>;
  /** Driving calls only: release the machine's pad after a timeout. */
  release?: () => Promise<PadRelease>;
  /** Where abandoned-call notes go. Default stderr. */
  log?: (line: string) => void;
}

class DeadlineReached extends Error {}

const RELEASE_BOUND_MS = 15_000;

function stderrLog(line: string): void {
  process.stderr.write(line.endsWith("\n") ? line : line + "\n");
}

/**
 * Run one call under its deadline, in line behind any driving call already on
 * its machine. A result object from a call that waited is stamped
 * `waitedForPreviousCallMs`.
 */
export async function guardCall<T>(spec: GuardSpec<T>): Promise<T> {
  const log = spec.log ?? stderrLog;
  const t0 = Date.now();
  const deadlineAt = t0 + spec.deadlineMs;
  const ctx: CallContext = { tool: spec.tool, machine: spec.machine, startedAt: t0, stage: null, children: new Set() };
  inFlight.add(ctx);
  let slot: QueueSlot | null = null;
  try {
    if (spec.queue && spec.machine != null) {
      slot = await spec.queue.acquire(spec.machine, spec.tool, deadlineAt - Date.now());
    }

    let timedOut = false;
    const attempt = (): Promise<T> => {
      // The tool's promise is ABANDONED at the deadline, not cancelled: no
      // tool takes a signal, and JavaScript cannot stop a promise from
      // outside. What can be stopped is stopped below (children, heartbeat,
      // pad). The promise keeps a handler so its eventual settling is logged
      // instead of becoming an unhandled rejection.
      const work = callContext.run(ctx, () => Promise.resolve().then(spec.run));
      return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
          timedOut = true;
          reject(new DeadlineReached());
        }, Math.max(0, deadlineAt - Date.now()));
        work.then(
          (v) => {
            clearTimeout(timer);
            if (timedOut) log(`[dps] abandoned ${spec.tool} finished ${Date.now() - deadlineAt} ms after its deadline; its result was discarded.`);
            else resolve(v);
          },
          (e) => {
            clearTimeout(timer);
            if (timedOut) log(`[dps] abandoned ${spec.tool} failed ${Date.now() - deadlineAt} ms after its deadline: ${(e as Error)?.stack ?? String(e)}`);
            else reject(e);
          },
        );
      });
    };

    let result: T;
    try {
      result = await (spec.around ? spec.around(attempt) : attempt());
    } catch (err) {
      if (!(err instanceof DeadlineReached)) throw err;
      // Kill children first: an abandoned press's pad.py may still hold the
      // serial port the release needs.
      const killed = killCallChildren(ctx);
      let release: PadRelease | null = null;
      if (spec.cls === "driving" && spec.release) {
        release = await boundRelease(spec.release);
      }
      throw new CallDeadlineError(
        spec.tool,
        spec.deadlineMs,
        spec.deadlineSource ?? "default",
        spec.cls,
        ctx.stage,
        killed,
        release,
      );
    }

    if (slot?.queued && result && typeof result === "object" && !Array.isArray(result)) {
      // Assigned, not spread, for the same reason as index.ts labelResult():
      // a picture attached by withImage() is a non-enumerable symbol.
      (result as Record<string, unknown>).waitedForPreviousCallMs = slot.waitedMs;
    }
    return result;
  } finally {
    // Freed on a timeout too. A promise that never settles would otherwise
    // hold the machine forever; the price is that an abandoned call which
    // wakes up later can press alongside the next one (see the lane D report).
    slot?.release();
    inFlight.delete(ctx);
  }
}

async function boundRelease(release: () => Promise<PadRelease>): Promise<PadRelease> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      release().catch((e: unknown) => ({ attempted: true, ok: false, detail: `the release threw: ${(e as Error)?.message ?? String(e)}` })),
      new Promise<PadRelease>((resolve) => {
        timer = setTimeout(
          () => resolve({ attempted: true, ok: false, detail: `the release did not answer within ${RELEASE_BOUND_MS} ms; the firmware/daemon watchdog neutralises the pad 750 ms after the link falls silent.` }),
          RELEASE_BOUND_MS,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Process-level handlers
// ---------------------------------------------------------------------------

const TRANSPORT_CODES = new Set(["EPIPE", "ERR_STREAM_DESTROYED", "ERR_STREAM_WRITE_AFTER_END"]);

/**
 * Is this the stdio transport itself failing? Then the peer is gone and there
 * is nobody left to answer, so the process exits as it always has.
 */
export function isStdioTransportError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" && TRANSPORT_CODES.has(code);
}

export interface CrashGuardOptions {
  log?: (line: string) => void;
  exit?: (code: number) => void;
}

/**
 * Before this, index.ts had no unhandledRejection/uncaughtException handler,
 * so one stray rejection anywhere ended the process and the chat lost every
 * DPS tool until a new chat was started. Now it is logged with the tool in
 * flight and the server keeps answering.
 */
export function installCrashGuards(opts: CrashGuardOptions = {}): void {
  const log = opts.log ?? stderrLog;
  const exit = opts.exit ?? ((code: number) => process.exit(code));
  const handler = (kind: string) => (err: unknown) => {
    const own = callContext.getStore();
    const where = own ? `${own.tool}${own.machine ? ` on "${own.machine}"` : ""}` : describeInFlight();
    const stack = (err as Error)?.stack ?? String(err);
    if (isStdioTransportError(err)) {
      log(`[dps] ${kind} in the stdio transport (tools in flight: ${where}); the peer is gone, exiting.\n${stack}`);
      exit(1);
      return;
    }
    log(`[dps] ${kind} caught and logged; the server stays up. Tools in flight: ${where}.\n${stack}`);
  };
  process.on("unhandledRejection", handler("unhandledRejection"));
  process.on("uncaughtException", handler("uncaughtException"));
}

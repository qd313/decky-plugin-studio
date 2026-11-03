/**
 * deck_probeDebugger -- what Steam's CEF debugger does, sample by sample, in the
 * seconds after a plugin_loader restart. Read-only: it lists targets and runs
 * two trivial reads, and never presses anything.
 *
 * Why it exists. deck_openPlugin's first try after a reload has failed on the
 * Deck after four fixes (issue #3), every one of them written against a fake
 * CEF. bonsAI's stricter set on 2026-10-22 read 1 of 3, both failures 1 s after
 * the reload with a "debugger connection reset". Nothing has recorded what the
 * debugger does in those seconds: whether it refuses, resets or hangs up, for
 * how long, whether /json/list goes empty, when the Quick Access page answers
 * again, and when Decky's tab is back on the rail. The roadmap's next step
 * (solo season item 1) is "measure first"; this is that measurement as one call.
 *
 * One sample every `intervalMs` (250 ms) for `seconds` (30):
 *   1. GET /json/list -- outcome, time, and the ids and titles listed;
 *   2. a socket to SharedJSContext and one to the Quick Access page, at once,
 *      each running one Runtime.evaluate: `1+1` on SharedJSContext, and on the
 *      Quick Access page the same read probeQuickAccess makes (readFocus.ts),
 *      which also says whether Decky's pane is mounted, i.e. its tab is on the
 *      rail;
 *   3. the ms since the restart note (loaderRestart.ts).
 * Each connect's outcome is one word: ok, ECONNRESET, "socket hang up",
 * ECONNREFUSED, timeout, http-error, closed (the socket closed after the
 * handshake, before the reply), not-listed, or error.
 *
 * What it cannot see. Through the SSH forward a refused connect on the Deck
 * reads HERE as a reset or a hang-up, because the local end of the forward
 * accepted the connection; ECONNREFUSED only shows on a machine reached
 * without a tunnel (a local stand-in). Samples run one after another, so a
 * sample that waits out a timeout (opTimeoutMs, 1.5 s) delays the next one;
 * `t` is when each sample started. With the Quick Access menu shut Steam may
 * mount no panes at all, so `deckyTab: false` with `visiblePane: null` is not
 * evidence that the tab is missing -- open the menu first if the rail matters.
 */
import { evaluate, listTargets, rewriteWsHost, ALWAYS_LISTED_TARGET, type CdpTarget } from "./cdp.js";
import { QUICK_ACCESS_PROBE_EXPRESSION } from "./readFocus.js";
import { loaderRestartNote, msSinceLoaderRestart, type LoaderRestartNote } from "./loaderRestart.js";

export type ProbeOutcome =
  | "ok"
  | "ECONNRESET"
  | "socket hang up"
  | "ECONNREFUSED"
  | "timeout"
  | "http-error"
  | "closed"
  | "not-listed"
  | "error";

/** One word for a failed list or connect, from the error's own text. */
export function classifyCdpFailure(message: string): ProbeOutcome {
  if (/ECONNRESET/i.test(message)) return "ECONNRESET";
  if (/socket hang up/i.test(message)) return "socket hang up";
  if (/ECONNREFUSED/i.test(message)) return "ECONNREFUSED";
  if (/timed out/i.test(message)) return "timeout";
  if (/returned HTTP \d+|upgrade refused/i.test(message)) return "http-error";
  if (/connection closed before a reply/i.test(message)) return "closed";
  return "error";
}

/** Outcomes that count as the debugger dropping a connection. */
const RESET_OUTCOMES: ReadonlySet<ProbeOutcome> = new Set(["ECONNRESET", "socket hang up", "closed"]);

export interface ProbeConnect {
  /** Title of the page asked, or null when none was listed. */
  target: string | null;
  outcome: ProbeOutcome;
  ms: number;
  error?: string;
}

export interface ProbeSample {
  /** When this sample started, in ms from the probe's zero (see ProbeDebuggerResult.zero). */
  t: number;
  /** msSinceLoaderRestart at this sample (a note an open call cleared still counts); null when no note is fresh. */
  sinceRestartMs: number | null;
  list: { outcome: ProbeOutcome; ms: number; error?: string; targets?: Array<{ id: string; title: string }> };
  /** Null when the list failed, so no page could be named. */
  sharedJs: ProbeConnect | null;
  quickAccess: (ProbeConnect & { visiblePane?: string | null; deckyPaneMounted?: boolean; paneCount?: number }) | null;
  /** Decky's pane mounted in the Quick Access page (its tab on the rail); null when the page did not answer. */
  deckyTab: boolean | null;
}

/** Consecutive samples that saw the same thing, collapsed. */
export interface ProbeSegment {
  fromMs: number;
  toMs: number;
  samples: number;
  list: ProbeOutcome;
  /** Titles listed, when the list answered. */
  targets?: string[];
  sharedJs: ProbeOutcome | null;
  quickAccess: ProbeOutcome | null;
  deckyTab: boolean | null;
}

export interface ProbeDebuggerSummary {
  /** "restart-note": t is ms since the restart note was written; "probe-start": no note was fresh. */
  zero: "restart-note" | "probe-start";
  zeroAt: string;
  restartNote: (LoaderRestartNote & { ageMs: number; fromFile: boolean }) | null;
  seconds: number;
  intervalMs: number;
  samples: number;
  /** First sample whose Quick Access read answered. */
  firstReadableQuickAccessMs: number | null;
  /** Start of the run of answering Quick Access reads that lasted to the end; null when the last one failed. */
  quickAccessStableFromMs: number | null;
  /** First sample with Decky's pane mounted in the Quick Access page. */
  firstDeckyTabMs: number | null;
  /** Lists and connects that were reset, hung up, or closed before their reply. */
  resetsSeen: number;
  lastResetMs: number | null;
  outcomes: {
    list: Partial<Record<ProbeOutcome, number>>;
    sharedJs: Partial<Record<ProbeOutcome, number>>;
    quickAccess: Partial<Record<ProbeOutcome, number>>;
  };
  timeline: ProbeSegment[];
}

export interface ProbeDebuggerOptions {
  cdpBase: string;
  /** How long to sample. Default 30, clamped to 1..300. */
  seconds?: number;
  /** Time between sample starts. Default 250 ms. Tests shorten it. */
  intervalMs?: number;
  /** Budget for each list and each connect. Default 1500 ms. */
  opTimeoutMs?: number;
  /** Which machine's restart note to read. Defaults to the current one. */
  restartMachine?: string;
}

export const DEFAULT_PROBE_SECONDS = 30;
export const MAX_PROBE_SECONDS = 300;
const DEFAULT_INTERVAL_MS = 250;
const DEFAULT_OP_TIMEOUT_MS = 1500;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function connectAndRead(
  wsUrl: string,
  base: string,
  title: string,
  expression: string,
  timeoutMs: number,
): Promise<{ connect: ProbeConnect; value: unknown }> {
  const started = Date.now();
  try {
    const value = await evaluate<unknown>(rewriteWsHost(wsUrl, base), expression, timeoutMs);
    return { connect: { target: title, outcome: "ok", ms: Date.now() - started }, value };
  } catch (err) {
    const message = (err as Error).message;
    return {
      connect: { target: title, outcome: classifyCdpFailure(message), ms: Date.now() - started, error: message },
      value: null,
    };
  }
}

const NOT_LISTED: ProbeConnect = { target: null, outcome: "not-listed", ms: 0 };

/** One sample. Exported for tests. */
export async function probeOnce(base: string, opTimeoutMs: number): Promise<Omit<ProbeSample, "t" | "sinceRestartMs">> {
  const listStarted = Date.now();
  let targets: CdpTarget[];
  try {
    targets = await listTargets(base, opTimeoutMs);
  } catch (err) {
    const message = (err as Error).message;
    return {
      list: { outcome: classifyCdpFailure(message), ms: Date.now() - listStarted, error: message },
      sharedJs: null,
      quickAccess: null,
      deckyTab: null,
    };
  }
  const list = {
    outcome: "ok" as const,
    ms: Date.now() - listStarted,
    targets: targets.map((t) => ({ id: t.id, title: t.title })),
  };
  const sj = targets.find((t) => t.title === ALWAYS_LISTED_TARGET && t.webSocketDebuggerUrl);
  const qa = targets.find((t) => Boolean(t.webSocketDebuggerUrl) && (t.title ?? "").toLowerCase().includes("quickaccess"));

  const [sjRead, qaRead] = await Promise.all([
    sj ? connectAndRead(sj.webSocketDebuggerUrl!, base, sj.title, "1+1", opTimeoutMs) : null,
    qa ? connectAndRead(qa.webSocketDebuggerUrl!, base, qa.title, QUICK_ACCESS_PROBE_EXPRESSION, opTimeoutMs) : null,
  ]);

  let quickAccess: ProbeSample["quickAccess"] = qaRead ? { ...qaRead.connect } : NOT_LISTED;
  let deckyTab: boolean | null = null;
  if (qaRead && qaRead.connect.outcome === "ok") {
    const v = (qaRead.value ?? {}) as { visiblePane?: unknown; deckyPaneMounted?: unknown; paneCount?: unknown };
    quickAccess = {
      ...qaRead.connect,
      visiblePane: typeof v.visiblePane === "string" ? v.visiblePane : null,
      ...(typeof v.deckyPaneMounted === "boolean" ? { deckyPaneMounted: v.deckyPaneMounted } : {}),
      ...(typeof v.paneCount === "number" ? { paneCount: v.paneCount } : {}),
    };
    deckyTab = typeof v.deckyPaneMounted === "boolean" ? v.deckyPaneMounted : null;
  }
  return { list, sharedJs: sjRead ? sjRead.connect : NOT_LISTED, quickAccess, deckyTab };
}

function count(into: Partial<Record<ProbeOutcome, number>>, o: ProbeOutcome | undefined): void {
  if (o) into[o] = (into[o] ?? 0) + 1;
}

/** Collapse consecutive samples that saw the same thing. Exported for tests. */
export function compactTimeline(samples: ProbeSample[]): ProbeSegment[] {
  const out: ProbeSegment[] = [];
  let key = "";
  for (const s of samples) {
    const titles = s.list.targets?.map((t) => t.title);
    const k = [s.list.outcome, titles?.join("\u0001") ?? "", s.sharedJs?.outcome ?? "-", s.quickAccess?.outcome ?? "-", String(s.deckyTab)].join("|");
    const last = out[out.length - 1];
    if (last && k === key) {
      last.toMs = s.t;
      last.samples++;
      continue;
    }
    key = k;
    out.push({
      fromMs: s.t,
      toMs: s.t,
      samples: 1,
      list: s.list.outcome,
      ...(titles ? { targets: titles } : {}),
      sharedJs: s.sharedJs?.outcome ?? null,
      quickAccess: s.quickAccess?.outcome ?? null,
      deckyTab: s.deckyTab,
    });
  }
  return out;
}

/** The numbers the result leads with, from the samples. Exported for tests. */
export function summarizeSamples(samples: ProbeSample[]): Pick<
  ProbeDebuggerSummary,
  "firstReadableQuickAccessMs" | "quickAccessStableFromMs" | "firstDeckyTabMs" | "resetsSeen" | "lastResetMs" | "outcomes"
> {
  const outcomes = { list: {}, sharedJs: {}, quickAccess: {} } as ProbeDebuggerSummary["outcomes"];
  let resetsSeen = 0;
  let lastResetMs: number | null = null;
  let firstReadableQuickAccessMs: number | null = null;
  let firstDeckyTabMs: number | null = null;
  let stableFrom: number | null = null;
  for (const s of samples) {
    count(outcomes.list, s.list.outcome);
    count(outcomes.sharedJs, s.sharedJs?.outcome);
    count(outcomes.quickAccess, s.quickAccess?.outcome);
    for (const o of [s.list.outcome, s.sharedJs?.outcome, s.quickAccess?.outcome]) {
      if (o && RESET_OUTCOMES.has(o)) {
        resetsSeen++;
        lastResetMs = s.t;
      }
    }
    const qaOk = s.quickAccess?.outcome === "ok";
    if (qaOk && firstReadableQuickAccessMs === null) firstReadableQuickAccessMs = s.t;
    if (s.deckyTab === true && firstDeckyTabMs === null) firstDeckyTabMs = s.t;
    if (qaOk) stableFrom ??= s.t;
    else stableFrom = null;
  }
  return { firstReadableQuickAccessMs, quickAccessStableFromMs: stableFrom, firstDeckyTabMs, resetsSeen, lastResetMs, outcomes };
}

/** Sample the debugger. Never throws for anything the Deck does; every failure is a sample. */
export async function sampleDebugger(opts: ProbeDebuggerOptions): Promise<{ summary: ProbeDebuggerSummary; samples: ProbeSample[] }> {
  const seconds = Math.min(MAX_PROBE_SECONDS, Math.max(1, Number(opts.seconds ?? DEFAULT_PROBE_SECONDS) || DEFAULT_PROBE_SECONDS));
  const intervalMs = Math.max(10, opts.intervalMs ?? DEFAULT_INTERVAL_MS);
  const opTimeoutMs = Math.max(50, opts.opTimeoutMs ?? DEFAULT_OP_TIMEOUT_MS);
  const started = Date.now();
  const note = loaderRestartNote(opts.restartMachine, started);
  const zeroAt = note ? note.at : started;
  const until = started + seconds * 1000;

  const samples: ProbeSample[] = [];
  for (let next = started; ; ) {
    const at = Date.now();
    if (at >= until) break;
    const one = await probeOnce(opts.cdpBase, opTimeoutMs);
    samples.push({ t: at - zeroAt, sinceRestartMs: msSinceLoaderRestart(opts.restartMachine, at, { includeCleared: true }), ...one });
    next += intervalMs;
    const wait = next - Date.now();
    if (wait > 0) await sleep(Math.min(wait, Math.max(0, until - Date.now())));
    else next = Date.now();
  }

  return {
    samples,
    summary: {
      zero: note ? "restart-note" : "probe-start",
      zeroAt: new Date(zeroAt).toISOString(),
      restartNote: note,
      seconds,
      intervalMs,
      samples: samples.length,
      ...summarizeSamples(samples),
      timeline: compactTimeline(samples),
    },
  };
}

/** One line for the result's summary. */
export function describeProbe(s: ProbeDebuggerSummary): string {
  const ms = (v: number | null): string => (v === null ? "never" : `${v} ms`);
  const zero = s.zero === "restart-note" ? `after the restart note (${s.restartNote?.source ?? "?"})` : "after the probe started (no fresh restart note)";
  return (
    `${s.samples} samples over ${s.seconds} s, times ${zero}: Quick Access page first readable ${ms(s.firstReadableQuickAccessMs)}, ` +
    `readable to the end from ${ms(s.quickAccessStableFromMs)}, Decky's tab first mounted ${ms(s.firstDeckyTabMs)}; ` +
    `${s.resetsSeen} reset${s.resetsSeen === 1 ? "" : "s"} or hang-up${s.resetsSeen === 1 ? "" : "s"}` +
    (s.lastResetMs !== null ? `, the last at ${s.lastResetMs} ms` : "") +
    `; ${s.timeline.length} distinct state${s.timeline.length === 1 ? "" : "s"} in the timeline`
  );
}

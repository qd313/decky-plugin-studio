/**
 * A ledger of every run (plan 12, lane C).
 *
 * bonsAI's runs/ folder held 457 evidence files named by hand, and a whole
 * subagent lane existed for "desk paperwork" during device rounds. This is the
 * other half of the answer to that (evidenceName.ts is the first): the dispatch
 * seam in index.ts hands every deck_* and plugin_* call to `Ledger.record`,
 * which appends ONE JSON line to runs/ledger/<session>.ndjson when the call
 * ends, however it ends. deck_runReport (tools/runReport.ts) reads the lines
 * back as the markdown a testing row expects.
 *
 * It sits at the seam, not inside tools, so a tool that is added tomorrow is in
 * the ledger tomorrow with no change of its own.
 *
 * WHAT A LINE SAYS, AND WHAT IT DOES NOT. `ok` is "the call returned and did
 * not say ok: false"; it is not "the thing under test passed". `presses` and
 * `fidelity` are copied from the result when it carries them, so a bare
 * "wire-sent" stays "sent". `buildHash` and `runningGame` are NOT read for the
 * ledger: they are the last answer a tool already gave this process about that
 * machine (deck_checkReady, deck_listGames, deck_launchGame, deck_exitGame),
 * stamped with when it was read (`stateReadAt`), dropped after
 * STATE_MAX_AGE_MS, and forgotten for the build when deck_deploy runs. A line
 * with no `buildHash` means nothing recent knew it, not that there is none.
 * `runningGame: null` means a recent read saw nothing running; a missing field
 * means no recent read at all.
 *
 * WRITING THE LEDGER CAN NEVER FAIL A CALL. Every step of recording is inside
 * one catch; the first failure is logged to stderr and later ones stay quiet.
 * What the seam hands back is exactly what the tool returned or threw.
 *
 * Not logged: deck_runReport (it would count itself), and deck_status /
 * deck_automationStatus, which the extension polls every 30 s -- a day of
 * polling would bury the runs. A tool can still be read by hand through its own
 * evidence; these two simply never are runs.
 */
import fs from "fs";
import path from "path";
import { getWorkspaceRoot } from "./config.js";
import { cleanRowId } from "./evidenceName.js";

export const LEDGER_SKIP: ReadonlySet<string> = new Set(["deck_runReport", "deck_status", "deck_automationStatus"]);

/** A build or game read older than this is not put on a ledger line. */
export const STATE_MAX_AGE_MS = 30 * 60_000;

const ERROR_MAX = 300;

export function ledgerDir(workspaceRoot: string): string {
  return path.join(workspaceRoot, "runs", "ledger");
}

/** `20261102T153012Z_pid4242`: server start time (UTC) and pid, safe in a file name on every OS. */
export function sessionId(startedAtMs: number, pid: number): string {
  const d = new Date(startedAtMs);
  const p = (n: number): string => String(n).padStart(2, "0");
  return (
    `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
    `T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z_pid${pid}`
  );
}

export interface MachineStamp {
  name: string;
  kind: string;
  os: string;
}

export interface RunningGame {
  appid: number;
  /** null when only the app id was known (deck_checkReady reads ids, not names). */
  name: string | null;
}

/** One line of runs/ledger/<session>.ndjson. Optional fields are absent, not null, unless noted. */
export interface LedgerLine {
  /** When the call started, ISO 8601 UTC. */
  ts: string;
  session: string;
  tool: string;
  /** From the result's own stamp, else the call's `machine` argument; null for a tool that is not about a machine. */
  machine: MachineStamp | null;
  /** The call returned and did not say `ok: false`. NOT "the test passed". */
  ok: boolean;
  durationMs: number;
  /** Copied from the result when it carries a count (walk, sweep, open, launch...) or is one press (press, assertFocusMove). */
  presses?: number;
  /** Copied from the result; null is "no press was sent". */
  fidelity?: string | null;
  evidenceFile?: string;
  /** The local build's hash, only when a recent deck_checkReady found the installed build equal to it. */
  buildHash?: string;
  /** What that read found; false means the installed build differed from the local one. */
  buildMatches?: boolean;
  /** `null` is "a recent read saw nothing running"; absent is "no recent read". */
  runningGame?: RunningGame | null;
  /** When the build/game above was read, ISO; absent when neither is on the line. */
  stateReadAt?: string;
  rowId?: string;
  /** First line of the thrown error, or of the result's `reason`/`summary` when it said ok: false; at most 300 characters. */
  error?: string;
  /** True when the call ended because its deadline passed. */
  deadline?: true;
  /** True when the result says the killswitch was thrown mid-run. */
  stopped?: true;
}

interface MachineState {
  buildHash?: string;
  buildMatches?: boolean;
  buildReadAt?: number;
  running?: RunningGame | null;
  runningReadAt?: number;
}

export interface LedgerOptions {
  /** Where lines go. A function so a test or a changed workspace is honoured at write time. */
  dir?: () => string;
  now?: () => number;
  pid?: number;
  startedAt?: number;
  /** Where the one "could not write" line goes. Default stderr. */
  log?: (line: string) => void;
}

export interface RecordSpec {
  tool: string;
  /** The call's own arguments (rowId, machine...), before the seam strips anything. */
  args: Record<string, unknown>;
  rowId?: string;
  /** The machine the call named, resolved by the seam; null when there is none or it does not resolve. Must not throw. */
  machineOf: (args: Record<string, unknown>) => MachineStamp | null;
}

export interface LedgerStatus {
  session: string;
  file: string;
  /** Lines this process has appended. */
  appended: number;
  /** The last write error, or null when the last write worked (or none has been tried). */
  lastError: string | null;
}

function firstLine(text: string): string {
  const line = text.split(/\r?\n/).find((l) => l.trim()) ?? "";
  const t = line.trim();
  return t.length > ERROR_MAX ? t.slice(0, ERROR_MAX - 1) + "…" : t;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function machineFromResult(result: unknown): MachineStamp | null {
  if (!isObj(result) || !isObj(result.machine)) return null;
  const m = result.machine;
  return typeof m.name === "string" ? { name: m.name, kind: String(m.kind ?? ""), os: String(m.os ?? "") } : null;
}

/** The fields of a result a ledger line copies. Pure, so a test can hand it any shape. */
export function summariseResult(tool: string, result: unknown): Partial<LedgerLine> {
  const out: Partial<LedgerLine> = {};
  if (!isObj(result)) return out;

  if (typeof result.presses === "number") out.presses = result.presses;
  else if (isObj(result.totals) && typeof result.totals.presses === "number") out.presses = result.totals.presses;
  else if (Array.isArray(result.stages) && result.stages.every((s) => isObj(s))) {
    const counts = (result.stages as Record<string, unknown>[]).map((s) => s.presses).filter((n): n is number => typeof n === "number");
    if (counts.length) out.presses = counts.reduce((a, b) => a + b, 0);
  } else if ((tool === "deck_pressButton" || tool === "deck_pressChord" || tool === "deck_assertFocusMove") && "fidelity" in result) {
    // One call is one press (a chord counts as the one call it is); a null fidelity means none was sent.
    out.presses = result.fidelity == null ? 0 : 1;
  }

  if ("fidelity" in result && (result.fidelity === null || typeof result.fidelity === "string")) {
    out.fidelity = result.fidelity as string | null;
  }

  if (typeof result.evidenceFile === "string" && result.evidenceFile) out.evidenceFile = result.evidenceFile;
  else if ((tool === "deck_captureScreenshot" || tool === "deck_record") && typeof result.path === "string" && result.path) {
    out.evidenceFile = result.path;
  }

  if (result.stopped === true) out.stopped = true;
  return out;
}

function runningFrom(v: unknown): RunningGame | null | undefined {
  // `undefined` = this value says nothing about what is running.
  if (v === null) return null;
  if (Array.isArray(v)) {
    const first = v.find((a) => isObj(a) && typeof a.appid === "number") as Record<string, unknown> | undefined;
    return first ? { appid: first.appid as number, name: typeof first.name === "string" ? first.name : null } : null;
  }
  if (isObj(v) && typeof v.appid === "number") return { appid: v.appid, name: typeof v.name === "string" ? v.name : null };
  return undefined;
}

export class Ledger {
  readonly session: string;
  private readonly dirFn: () => string;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private readonly state = new Map<string, MachineState>();
  private appended = 0;
  private lastError: string | null = null;
  private warned = false;

  constructor(opts: LedgerOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.dirFn = opts.dir ?? (() => ledgerDir(getWorkspaceRoot()));
    this.log = opts.log ?? ((l) => process.stderr.write(l.endsWith("\n") ? l : l + "\n"));
    this.session = sessionId(opts.startedAt ?? this.now(), opts.pid ?? process.pid);
  }

  file(): string {
    return path.join(this.dirFn(), `${this.session}.ndjson`);
  }

  status(): LedgerStatus {
    let file = "";
    try {
      file = this.file();
    } catch {
      /* a broken dir function is reported by lastError, not thrown */
    }
    return { session: this.session, file, appended: this.appended, lastError: this.lastError };
  }

  /**
   * Run the call and write its line. The call's result or error is returned or
   * rethrown untouched; nothing the ledger does can change it.
   */
  async record<T>(spec: RecordSpec, run: () => Promise<T>): Promise<T> {
    if (LEDGER_SKIP.has(spec.tool)) return run();
    const t0 = this.now();
    let result: T;
    try {
      result = await run();
    } catch (err) {
      this.append(() => this.errorLine(spec, t0, err));
      throw err;
    }
    this.append(() => this.resultLine(spec, t0, result));
    return result;
  }

  /** Everything that can go wrong in building or writing a line goes wrong in here, and nowhere else. */
  private append(build: () => LedgerLine): void {
    try {
      const line = build();
      const dir = this.dirFn();
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(path.join(dir, `${this.session}.ndjson`), JSON.stringify(line) + "\n", "utf8");
      this.appended++;
      this.lastError = null;
    } catch (err) {
      this.lastError = (err as Error)?.message ?? String(err);
      if (!this.warned) {
        this.warned = true;
        try {
          this.log(`[dps] ledger: could not write a line (${this.lastError}); the call is not affected. Further ledger errors are not logged.`);
        } catch {
          /* even logging must not throw */
        }
      }
    }
  }

  private base(spec: RecordSpec, t0: number, machine: MachineStamp | null): LedgerLine {
    return {
      ts: new Date(t0).toISOString(),
      session: this.session,
      tool: spec.tool,
      machine,
      ok: true,
      durationMs: Math.max(0, this.now() - t0),
      ...(spec.rowId ? { rowId: spec.rowId } : {}),
    };
  }

  private errorLine(spec: RecordSpec, t0: number, err: unknown): LedgerLine {
    const machine = spec.machineOf(spec.args);
    const line = this.base(spec, t0, machine);
    line.ok = false;
    line.error = firstLine((err as Error)?.message ?? String(err)) || "unknown error";
    if ((err as Error)?.name === "CallDeadlineError") line.deadline = true;
    return line;
  }

  private resultLine(spec: RecordSpec, t0: number, result: unknown): LedgerLine {
    const machine = machineFromResult(result) ?? spec.machineOf(spec.args);
    const line = this.base(spec, t0, machine);
    if (isObj(result) && result.ok === false) {
      line.ok = false;
      const why = typeof result.reason === "string" && result.reason.trim() ? result.reason : typeof result.summary === "string" ? result.summary : "";
      line.error = firstLine(why) || "the result said ok: false and gave no reason";
    }
    Object.assign(line, summariseResult(spec.tool, result));
    if (machine) {
      this.observe(spec.tool, machine.name, result);
      this.stampState(line, machine.name);
    }
    return line;
  }

  /** Remember what a tool's answer just taught us about a machine. Never reads anything itself. */
  private observe(tool: string, machine: string, result: unknown): void {
    const st = this.state.get(machine) ?? {};
    const at = this.now();
    this.state.set(machine, st);

    if (tool === "deck_deploy") {
      delete st.buildHash;
      delete st.buildMatches;
      delete st.buildReadAt;
      return;
    }
    if (!isObj(result)) return;

    if (tool === "deck_checkReady" && isObj(result.checks)) {
      const b = result.checks.buildMatches;
      if (isObj(b) && b.verdict !== "unknown" && typeof b.actual === "boolean") {
        st.buildMatches = b.actual;
        st.buildReadAt = at;
        if (b.actual && typeof b.localHash === "string" && b.localHash) st.buildHash = b.localHash;
        else delete st.buildHash;
      }
      const r = result.checks.runningAppId;
      if (isObj(r) && r.verdict !== "unknown" && Array.isArray(r.actual)) {
        const ids = r.actual.filter((n): n is number => typeof n === "number");
        if (ids.length === 0) st.running = null;
        else {
          const prev = st.running;
          st.running = { appid: ids[0], name: prev && prev.appid === ids[0] ? prev.name : null };
        }
        st.runningReadAt = at;
      }
      return;
    }
    if (tool === "deck_listGames" && result.ok !== false) {
      const running = Array.isArray(result.running) ? runningFrom(result.running) : undefined;
      if (running !== undefined) {
        st.running = running;
        st.runningReadAt = at;
      }
      return;
    }
    // A launch or an exit that RunningApps confirmed (ok: true) is a read too.
    if ((tool === "deck_launchGame" || tool === "deck_exitGame") && result.ok === true) {
      const running = tool === "deck_exitGame" ? null : runningFrom(result.running);
      if (running !== undefined) {
        st.running = running;
        st.runningReadAt = at;
      }
    }
  }

  private stampState(line: LedgerLine, machine: string): void {
    const st = this.state.get(machine);
    if (!st) return;
    const now = this.now();
    const fresh = (t: number | undefined): t is number => t !== undefined && now - t <= STATE_MAX_AGE_MS;
    let readAt: number | undefined;
    if (fresh(st.buildReadAt)) {
      if (st.buildHash) line.buildHash = st.buildHash;
      if (st.buildMatches !== undefined) line.buildMatches = st.buildMatches;
      readAt = st.buildReadAt;
    }
    if (fresh(st.runningReadAt) && st.running !== undefined) {
      line.runningGame = st.running;
      readAt = readAt === undefined ? st.runningReadAt : Math.max(readAt, st.runningReadAt);
    }
    if (readAt !== undefined) line.stateReadAt = new Date(readAt).toISOString();
  }
}

// ---------------------------------------------------------------------------
// The seam's side of it
// ---------------------------------------------------------------------------

export interface SeamConfig {
  /** Tools that read `rowId` themselves; for every other tool the seam strips it before dispatch. */
  rowIdTools: ReadonlySet<string>;
  /** Tools about the registry or the killswitch: a call that names no machine is "no machine", not the default one. */
  registryTools: ReadonlySet<string>;
  /** The machine a `machine` argument names (the default one when absent), or null when it does not resolve. Must not throw. */
  stampOf: (args: Record<string, unknown>) => MachineStamp | null;
}

/**
 * What index.ts's dispatch seam does for the ledger, kept here so it can be
 * tested without starting a server. Only deck_* and plugin_* calls are
 * recorded. `rowId` is read for the ledger from every call, and withheld from
 * a tool that does not use it (deck_configure writes its whole params object
 * into deck.env, and must never see it). `run` receives the arguments the tool
 * is to be dispatched with.
 */
export function recordAtSeam<T>(
  ledger: Ledger,
  cfg: SeamConfig,
  tool: string,
  params: Record<string, unknown>,
  run: (args: Record<string, unknown>) => Promise<T>,
): Promise<T> {
  if (!tool.startsWith("deck_") && !tool.startsWith("plugin_")) return run(params);
  let args = params;
  if (!cfg.rowIdTools.has(tool) && Object.prototype.hasOwnProperty.call(params, "rowId")) {
    const { rowId: _rowId, ...rest } = params;
    args = rest;
  }
  const machineOf = (a: Record<string, unknown>): MachineStamp | null => {
    // plugin_* tools are about the workspace; a registry tool names a machine only to act on it.
    if (tool.startsWith("plugin_") || (cfg.registryTools.has(tool) && a.machine == null)) return null;
    return cfg.stampOf(a);
  };
  return ledger.record({ tool, args: params, rowId: cleanRowId(params.rowId), machineOf }, () => run(args));
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export interface ReadLedgerResult {
  /** The ledger files read, newest session last. */
  files: string[];
  lines: LedgerLine[];
  /** Lines that were not valid ledger JSON (a half-written last line, a hand edit). */
  malformed: number;
}

/**
 * Read ledger lines back. `session` names one session (its id, with or without
 * ".ndjson"); omitted, every session in the folder is read, oldest first.
 * Reading never throws: a missing folder is an empty ledger.
 */
export function readLedger(dir: string, opts: { session?: string } = {}): ReadLedgerResult {
  const out: ReadLedgerResult = { files: [], lines: [], malformed: 0 };
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith(".ndjson")).sort();
  } catch {
    return out;
  }
  if (opts.session) {
    const want = opts.session.endsWith(".ndjson") ? opts.session : `${opts.session}.ndjson`;
    // Compared against the listing, so a session argument cannot name a path.
    names = names.filter((n) => n === want);
  }
  for (const n of names) {
    const file = path.join(dir, n);
    let text: string;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    out.files.push(file);
    for (const raw of text.split(/\r?\n/)) {
      if (!raw.trim()) continue;
      try {
        const v = JSON.parse(raw);
        if (isObj(v) && typeof v.tool === "string" && typeof v.ts === "string") out.lines.push(v as unknown as LedgerLine);
        else out.malformed++;
      } catch {
        out.malformed++;
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// The process's own ledger
// ---------------------------------------------------------------------------

let current: Ledger | null = null;

/** The one ledger of this server process, started on first use. */
export function getLedger(): Ledger {
  if (!current) current = new Ledger();
  return current;
}

/** Test seam: replace (or clear) the process's ledger. */
export function setLedgerForTest(l: Ledger | null): void {
  current = l;
}

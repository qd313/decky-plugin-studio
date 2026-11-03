/**
 * deck_runReport: the ledger (ledger.ts) read back as the block a testing row
 * expects -- tool, machine, build, verdict, evidence path -- plus a totals line.
 *
 * Read-only: it takes no lease and presses nothing. Which lines it reads:
 *   - `session` names one session (the id the ledger file is called, with or
 *     without ".ndjson"); "all" reads every session in runs/ledger/.
 *   - With none of session, rowId or since, it reads THIS server's session, so
 *     "report what I just did" is the bare call.
 *   - With a rowId or a since and no session it reads every session, because a
 *     testing row can span a server restart.
 *   - `since` is an ISO date or time, or a span back from now: "30m", "2h", "1d".
 *   - `rowId` keeps the lines that carried that row id, exactly.
 *   - `machine` keeps the lines for that machine name.
 *
 * What the block does not say: a verdict here is "the call returned ok", not
 * "the row passed". Build and game columns are the last answer a tool gave this
 * server (ledger.ts says how old one can be); "not read" means none did.
 */
import path from "path";
import { LedgerLine, readLedger } from "../ledger.js";

export interface RunReportOptions {
  session?: string;
  rowId?: string;
  since?: string;
  machine?: string;
}

export interface RunReportContext {
  /** runs/ledger/ */
  dir: string;
  /** This server's own session id, read when no filter is given. */
  currentSession: string;
  /** Evidence paths inside this folder are shown relative to it. */
  workspaceRoot: string;
  now?: () => number;
}

export interface RunReportTotals {
  calls: number;
  ok: number;
  failed: number;
  deadlines: number;
  stopped: number;
  presses: number;
  evidenceFiles: number;
  byTool: Record<string, number>;
}

export interface RunReportResult {
  ok: true;
  /** The session asked for, "all", or this server's own. */
  session: string;
  /** The ledger files that were read. */
  files: string[];
  rowId?: string;
  machine?: string;
  /** The `since` filter as an ISO time. */
  since?: string;
  totals: RunReportTotals;
  /** One sentence, also the last line of `markdown`. */
  totalsLine: string;
  /** Ledger lines that were not valid JSON and were skipped. */
  malformed: number;
  markdown: string;
}

/** An ISO date/time, or "<n>m" / "<n>h" / "<n>d" back from now, as epoch ms. Throws a plain message on anything else. */
export function parseSince(raw: string, nowMs: number): number {
  const s = raw.trim();
  const rel = /^(\d+(?:\.\d+)?)\s*([mhd])$/i.exec(s);
  if (rel) {
    const unit = { m: 60_000, h: 3_600_000, d: 86_400_000 }[rel[2].toLowerCase() as "m" | "h" | "d"];
    return nowMs - Number(rel[1]) * unit;
  }
  const t = Date.parse(s);
  if (!Number.isFinite(t)) {
    throw new Error(`since must be an ISO date or time (2026-11-02T14:00:00Z) or a span back from now (30m, 2h, 1d); got ${JSON.stringify(raw)}.`);
  }
  return t;
}

function cell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function when(ts: string): string {
  const t = Date.parse(ts);
  return Number.isFinite(t) ? new Date(t).toISOString().replace("T", " ").replace(/\.\d+Z$/, "Z") : ts;
}

function shortPath(file: string, root: string): string {
  try {
    const rel = path.relative(root, file);
    if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) return rel.split(path.sep).join("/");
  } catch {
    /* fall through to the path as recorded */
  }
  return file;
}

function seconds(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

function machineCell(l: LedgerLine): string {
  return l.machine ? `${l.machine.name} (${l.machine.kind || "?"}, ${l.machine.os || "?"})` : "none";
}

function buildCell(l: LedgerLine): string {
  if (l.buildHash) return `\`${l.buildHash.slice(0, 12)}\``;
  if (l.buildMatches === false) return "differs from local";
  return "not read";
}

function verdictCell(l: LedgerLine): string {
  if (!l.ok) {
    const kind = l.deadline ? "DEADLINE" : l.stopped ? "STOPPED" : "FAILED";
    const why = l.error ?? "no reason given";
    // The ledger keeps 300 characters; a table row keeps the part a reader needs.
    return `${kind}: ${why.length > 160 ? why.slice(0, 159) + "…" : why}`;
  }
  const bits = ["ok"];
  if (l.stopped) bits[0] = "STOPPED";
  if (l.fidelity) bits.push(l.fidelity);
  if (typeof l.presses === "number") bits.push(`${l.presses} press${l.presses === 1 ? "" : "es"}`);
  bits.push(seconds(l.durationMs));
  return bits.join(" · ");
}

export function totalsOf(lines: LedgerLine[]): RunReportTotals {
  const byTool: Record<string, number> = {};
  let ok = 0;
  let deadlines = 0;
  let stopped = 0;
  let presses = 0;
  let evidenceFiles = 0;
  for (const l of lines) {
    byTool[l.tool] = (byTool[l.tool] ?? 0) + 1;
    if (l.ok) ok++;
    if (l.deadline) deadlines++;
    if (l.stopped) stopped++;
    if (typeof l.presses === "number") presses += l.presses;
    if (l.evidenceFile) evidenceFiles++;
  }
  return { calls: lines.length, ok, failed: lines.length - ok, deadlines, stopped, presses, evidenceFiles, byTool };
}

function totalsSentence(t: RunReportTotals, lines: LedgerLine[]): string {
  if (t.calls === 0) return "Totals: no calls matched.";
  const parts = [`${t.calls} call${t.calls === 1 ? "" : "s"}: ${t.ok} ok, ${t.failed} failed`];
  const extra = [t.deadlines ? `${t.deadlines} past their deadline` : "", t.stopped ? `${t.stopped} stopped by the killswitch` : ""].filter(Boolean);
  let s = `Totals: ${parts[0]}${extra.length ? ` (${extra.join(", ")})` : ""}; ${t.presses} press${t.presses === 1 ? "" : "es"} sent; ${t.evidenceFiles} evidence file${t.evidenceFiles === 1 ? "" : "s"}`;
  const byMachine = new Map<string, number>();
  for (const l of lines) {
    const k = l.machine ? `${l.machine.name} (${l.machine.kind || "?"})` : "no machine";
    byMachine.set(k, (byMachine.get(k) ?? 0) + 1);
  }
  s += `; machines: ${[...byMachine].map(([k, n]) => `${k} x${n}`).join(", ")}.`;
  return s;
}

export function runReport(opts: RunReportOptions, ctx: RunReportContext): RunReportResult {
  const nowMs = (ctx.now ?? Date.now)();
  const rowId = opts.rowId?.trim() || undefined;
  const machine = opts.machine?.trim() || undefined;
  const sinceMs = opts.since != null && String(opts.since).trim() ? parseSince(String(opts.since), nowMs) : undefined;

  const asked = opts.session?.trim() || undefined;
  const filtered = rowId !== undefined || sinceMs !== undefined;
  const session = asked ?? (filtered ? "all" : ctx.currentSession);
  const read = readLedger(ctx.dir, session === "all" ? {} : { session });

  const lines = read.lines
    .filter((l) => (rowId === undefined ? true : l.rowId === rowId))
    .filter((l) => (machine === undefined ? true : l.machine?.name === machine))
    .filter((l) => {
      if (sinceMs === undefined) return true;
      const t = Date.parse(l.ts);
      return Number.isFinite(t) && t >= sinceMs;
    })
    .sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));

  const totals = totalsOf(lines);
  const totalsLine = totalsSentence(totals, lines);

  const title =
    `### Run report: ${rowId ? `row \`${rowId}\`, ` : ""}${session === "all" ? "every session" : `session \`${session}\``}` +
    `${machine ? `, machine ${machine}` : ""}${sinceMs !== undefined ? `, since ${new Date(sinceMs).toISOString()}` : ""}`;

  const md: string[] = [title, ""];
  if (lines.length === 0) {
    md.push(
      read.files.length === 0
        ? `No ledger found for this selection (looked in ${ctx.dir}).`
        : "The ledger has no line matching this selection.",
      "",
    );
  } else {
    const showRow = lines.some((l) => l.rowId);
    md.push(`| # | When (UTC) | Tool | Machine | Build | Verdict |${showRow ? " Row |" : ""} Evidence |`);
    md.push(`|---|---|---|---|---|---|${showRow ? "---|" : ""}---|`);
    lines.forEach((l, i) => {
      const ev = l.evidenceFile ? `\`${cell(shortPath(l.evidenceFile, ctx.workspaceRoot))}\`` : "none";
      md.push(
        `| ${i + 1} | ${when(l.ts)} | ${l.tool} | ${cell(machineCell(l))} | ${buildCell(l)} | ${cell(verdictCell(l))} |` +
          `${showRow ? ` ${cell(l.rowId ?? "")} |` : ""} ${ev} |`,
      );
    });
    md.push("");
    const running = lines.filter((l) => l.runningGame !== undefined);
    if (running.length) {
      const last = running[running.length - 1];
      md.push(
        `Game, last read: ${last.runningGame ? `${last.runningGame.name ?? "app " + last.runningGame.appid} (${last.runningGame.appid})` : "nothing running"}` +
          `${last.stateReadAt ? `, read ${when(last.stateReadAt)}` : ""}.`,
        "",
      );
    }
    if (lines.some((l) => l.machine?.kind === "standin")) {
      md.push("Includes stand-in runs (`kind: standin`): do not file those as the Deck's verdict.", "");
    }
  }
  md.push(totalsLine);
  if (read.malformed) md.push("", `(${read.malformed} ledger line${read.malformed === 1 ? "" : "s"} could not be read and ${read.malformed === 1 ? "was" : "were"} skipped.)`);
  md.push(
    "",
    "_Verdict means the call returned ok, not that the row passed. Build and game come from the last deck_checkReady, deck_listGames or launch/exit this server ran; \"not read\" means none did in the last 30 minutes._",
  );

  return {
    ok: true,
    session,
    files: read.files,
    ...(rowId ? { rowId } : {}),
    ...(machine ? { machine } : {}),
    ...(sinceMs !== undefined ? { since: new Date(sinceMs).toISOString() } : {}),
    totals,
    totalsLine,
    malformed: read.malformed,
    markdown: md.join("\n"),
  };
}

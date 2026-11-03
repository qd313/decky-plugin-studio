/**
 * studio_reportIssue: file a Decky Plugin Studio issue from inside the IDE,
 * with a redacted diagnostic bundle, and never without showing the text first.
 *
 * Why this exists: bonsAI's findings log held about twenty DPS-side
 * observations marked "Open, needs filing" that never became issues here,
 * because filing meant leaving the editor and re-gathering what the server
 * already knew (docs/planning/01-dpad-focus-oracle-and-issue-intake.md Part B).
 *
 * Three rules:
 *
 *   1. A DRY RUN COMES FIRST, ALWAYS. `dryRun` defaults to true and returns
 *      the exact markdown that would be posted plus a `confirmToken`. A post
 *      (`dryRun: false`) needs that token. The server keeps the markdown it
 *      handed out, keyed by the token, and posts THAT, not a fresh render, so
 *      what a person read is what goes to a public repo. A token this server
 *      did not issue, or one issued for a different title/body/surface, is
 *      refused. (The bundle is not re-collected at post time: it holds
 *      timestamps and the recent-call list, which move while a person reads.)
 *   2. REDACTION RUNS ON THE WHOLE RENDER, the agent's own prose included, and
 *      removes what it can recognise: IPv4/IPv6 addresses, home paths, the
 *      workspace path, the values in deck.env, the OS user name, machine hosts
 *      from machines.json, email addresses and token shapes. It cannot know
 *      what it was never told (a plugin name, a repo name, a host nickname
 *      that is not in machines.json), so a person still reads the markdown.
 *   3. NOTHING HERE TOUCHES A DECK. The bundle is read from this machine's
 *      own state. The only outside call is `gh`, and only on a confirmed post.
 */
import { spawn } from "child_process";
import crypto from "crypto";
import fs from "fs";
import net from "net";
import os from "os";
import path from "path";

import { getWorkspaceRoot, readDeckEnv } from "../config.js";
import { listMachines } from "../machines.js";
import { automationStatus } from "../deck/killswitch.js";
import { defaultContext, studioDoctor, type DoctorReport } from "./doctor.js";

export const ISSUE_REPO = "qd313/decky-plugin-studio";

export const SURFACES = ["deck", "standin", "extension", "server"] as const;
export type Surface = (typeof SURFACES)[number];
export type Source = "agent" | "human";

// ---------------------------------------------------------------------------
// The ring of recent calls, and the reportId a failed call carries
// ---------------------------------------------------------------------------

export interface CallRecord {
  at: string;
  tool: string;
  ok: boolean;
  durationMs: number;
  /** First line of the error text, failures only. */
  error?: string;
  /** Failures only: the id the error text told the caller to quote. */
  reportId?: string;
}

const RING_MAX = 50;
const ring: CallRecord[] = [];

export function recordCall(rec: CallRecord): void {
  ring.push(rec);
  if (ring.length > RING_MAX) ring.splice(0, ring.length - RING_MAX);
}

export function recentCalls(n = 20): CallRecord[] {
  return ring.slice(-n);
}

/** Test seam. */
export function clearCallRing(): void {
  ring.length = 0;
}

/** A short id: a hash of the tool name and the timestamp. Nothing secret, nothing unique-guaranteed. */
export function makeReportId(tool: string, atIso: string): string {
  return "r" + crypto.createHash("sha256").update(`${tool}|${atIso}`).digest("hex").slice(0, 6);
}

const REPORT_MARK = "[DPS report id:";

/**
 * Put a failed call in the ring and add its reportId to the error text the
 * caller reads. The error object is the same one (class and stack intact);
 * only its message grows. studio_reportIssue's own refusals are recorded but
 * not stamped: telling a caller who just misused the tool to file a report
 * about it helps nobody.
 */
export function annotateFailure(tool: string, err: unknown, durationMs = 0, now: () => number = Date.now): unknown {
  const at = new Date(now()).toISOString();
  const text = err instanceof Error ? err.message : String(err);
  const reportId = makeReportId(tool, at);
  const firstLine = text.split(/\r?\n/).find((l) => l.trim()) ?? "";
  recordCall({ at, tool, ok: false, durationMs, error: firstLine.slice(0, 200), reportId });
  if (tool === "studio_reportIssue" || text.includes(REPORT_MARK)) return err;
  const suffix =
    `\n${REPORT_MARK} ${reportId}] To file this upstream, call studio_reportIssue { title, body } ` +
    `(it returns the text first; nothing is posted without your confirmToken).`;
  if (err instanceof Error) {
    err.message = err.message + suffix;
    return err;
  }
  return new Error(text + suffix);
}

/** Wrap one tool call: record it, and stamp the error if it throws. Used by index.ts handle(). */
export async function withCallRecord<T>(tool: string, fn: () => Promise<T>, now: () => number = Date.now): Promise<T> {
  const t0 = now();
  try {
    const result = await fn();
    recordCall({ at: new Date(t0).toISOString(), tool, ok: true, durationMs: now() - t0 });
    return result;
  } catch (err) {
    throw annotateFailure(tool, err, now() - t0, now);
  }
}

let serverInfo: { name: string; version: string } | null = null;

/** index.ts hands over its own SERVER_INFO so the bundle reports what is running, not what a file says. */
export function setServerInfo(info: { name: string; version: string }): void {
  serverInfo = info;
}

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

export interface RedactionSpec {
  /** deck.env values that are addresses (DECK_IP). */
  ips?: string[];
  /** User names: deck.env DECK_USER, the OS user, machine users. */
  users?: string[];
  /** Host names and aliases from machines.json and the OS. */
  hosts?: string[];
  workspace?: string;
  home?: string;
}

export interface Redacted {
  text: string;
  counts: Record<string, number>;
}

/** Public defaults and common words: redacted only in an obvious context (user@, DECK_USER=), never everywhere. */
const GENERIC_NAMES = new Set(["deck", "root", "user", "admin", "steam", "steamdeck", "localhost"]);

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function redact(input: string, spec: RedactionSpec = {}): Redacted {
  const counts: Record<string, number> = {};
  const bump = (kind: string): void => {
    counts[kind] = (counts[kind] ?? 0) + 1;
  };
  let text = input;
  const sub = (re: RegExp, kind: string, to: string | ((m: string, ...g: string[]) => string)): void => {
    text = text.replace(re, (...args) => {
      const m = args[0] as string;
      const out = typeof to === "function" ? to(m, ...(args.slice(1) as string[])) : to;
      if (out !== m) bump(kind);
      return out;
    });
  };

  // 1. Paths. The workspace and the home folder first, in every slash spelling
  //    (and the JSON-escaped one), then any other user's home folder.
  const pathForms = (p: string): string[] => {
    const fwd = p.replace(/\\/g, "/");
    const back = p.replace(/\//g, "\\");
    return [...new Set([p, fwd, back, back.replace(/\\/g, "\\\\")])].filter((x) => x.length > 3);
  };
  for (const [p, to, kind] of [
    [spec.workspace, "<workspace>", "workspace path"],
    [spec.home, "~", "home path"],
  ] as const) {
    if (!p) continue;
    for (const form of pathForms(p).sort((a, b) => b.length - a.length)) {
      sub(new RegExp(escapeRe(form), "gi"), kind, to);
    }
  }
  sub(/[A-Za-z]:[\\/]+Users[\\/]+[^\\/\s"'`<>|]+/gi, "home path", "~");
  sub(/(?:\/[A-Za-z])?\/Users\/[^/\s"'`<>|]+/g, "home path", "~");
  sub(/\/home\/[^/\s"'`<>|]+/g, "home path", "~");

  // 2. Addresses. IPv6 before IPv4 so ::ffff:1.2.3.4 goes in one piece.
  sub(/(?<![\w:.])[0-9A-Fa-f:.]*:[0-9A-Fa-f:.]*(?:%[\w.-]+)?(?![\w:])/g, "IPv6 address", (m) => {
    const bare = m.replace(/%[\w.-]+$/, "");
    return (bare.match(/:/g) ?? []).length >= 2 && net.isIPv6(bare) ? "<ip>" : m;
  });
  sub(/(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?!\d)/g, "IPv4 address", (m) =>
    m.split(".").every((o) => Number(o) <= 255) ? "<ip>" : m,
  );

  // 3. Things that are never wanted in an issue.
  sub(/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, "token", "<token>");
  sub(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, "token", "<token>");
  sub(/\bsk-[A-Za-z0-9_-]{20,}\b/g, "token", "<token>");
  sub(/\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/g, "token", "Bearer <token>");
  sub(/\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g, "email address", "<email>");

  // 4. deck.env and friends: by value, then by key.
  const bareNames = (list: string[] | undefined): { loud: string[]; quiet: string[] } => {
    const loud: string[] = [];
    const quiet: string[] = [];
    for (const v of new Set((list ?? []).map((x) => x.trim()).filter(Boolean))) {
      (GENERIC_NAMES.has(v.toLowerCase()) || v.length < 3 ? quiet : loud).push(v);
    }
    // Longest first, so "steamdeck.local" goes before "steamdeck".
    loud.sort((a, b) => b.length - a.length);
    return { loud, quiet };
  };
  const word = (v: string): RegExp => new RegExp(`(?<![A-Za-z0-9_])${escapeRe(v)}(?![A-Za-z0-9_])`, "gi");
  for (const ip of spec.ips ?? []) {
    if (ip.trim()) sub(new RegExp(escapeRe(ip.trim()), "gi"), "deck.env value", "<deck-ip>");
  }
  const users = bareNames(spec.users);
  const hosts = bareNames(spec.hosts);
  for (const v of users.loud) sub(word(v), "user name", "<user>");
  for (const v of hosts.loud) sub(word(v), "host name", "<host>");
  for (const v of [...users.quiet, ...hosts.quiet]) {
    // user@host, whatever the user is: the part before @ is an identity.
    sub(new RegExp(`(?<![A-Za-z0-9_])${escapeRe(v)}@`, "gi"), "user name", "<user>@");
  }
  sub(/\b(DECK_IP|DECK_USER)\s*=\s*[^\s,;"']+/g, "deck.env value", (_m, key) => `${key}=<redacted>`);
  sub(/[\w.-]+@(?=<ip>|<deck-ip>|<host>)/g, "user name", "<user>@");

  return { text, counts };
}

// ---------------------------------------------------------------------------
// The bundle
// ---------------------------------------------------------------------------

export interface GhResult {
  code: number | null;
  stdout: string;
  stderr: string;
  /** The process could not start at all (gh not installed). */
  error?: string;
}

export interface ReportDeps {
  now: () => number;
  workspace: () => string;
  home: () => string;
  osUser: () => string;
  hostname: () => string;
  deckEnv: () => Record<string, string>;
  machines: () => Array<{ name: string; kind: string; os: string; host?: string; user?: string }>;
  doctor: (p: { workspace?: string; extensionVersion?: string }) => Promise<DoctorReport>;
  latch: () => ReturnType<typeof automationStatus>;
  calls: () => CallRecord[];
  /** The newest runs/ledger/*.ndjson tail, or null when there is no ledger. */
  ledger: (workspace: string, lines: number) => { file: string; lines: string[] } | null;
  versions: (extensionVersion?: string) => Record<string, unknown>;
  gh: (args: string[], stdin?: string) => Promise<GhResult>;
}

function readVersion(file: string): string | null {
  try {
    const v = (JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, "")) as { version?: unknown }).version;
    return typeof v === "string" ? v : null;
  } catch {
    return null;
  }
}

function defaultVersions(extensionVersion?: string): Record<string, unknown> {
  const mcpRoot = defaultContext().mcpServerRoot;
  const parent = path.join(mcpRoot, "..");
  return {
    root: readVersion(path.join(parent, "package.json")) ?? "not found (not a DPS checkout)",
    extension: readVersion(path.join(parent, "extension", "package.json")) ?? "not found (not a DPS checkout)",
    extensionReportedByCaller: extensionVersion ?? "not passed",
    server: readVersion(path.join(mcpRoot, "package.json")) ?? "not found",
    serverInfo: serverInfo ? `${serverInfo.name} ${serverInfo.version}` : "not set (this process is not running under index.ts)",
    node: process.version,
    platform: `${process.platform} ${process.arch}`,
  };
}

const LEDGER_LINE_MAX = 400;

function defaultLedger(workspace: string, lines: number): { file: string; lines: string[] } | null {
  const dir = path.join(workspace, "runs", "ledger");
  let newest: { file: string; mtime: number } | null = null;
  try {
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith(".ndjson")) continue;
      const file = path.join(dir, name);
      const mtime = fs.statSync(file).mtimeMs;
      if (!newest || mtime > newest.mtime) newest = { file, mtime };
    }
    if (!newest) return null;
    const size = fs.statSync(newest.file).size;
    const fd = fs.openSync(newest.file, "r");
    try {
      const len = Math.min(size, 256 * 1024);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);
      const all = buf.toString("utf8").split(/\r?\n/).filter((l) => l.trim());
      // A tail read can start mid-line; drop that fragment.
      const whole = size > len ? all.slice(1) : all;
      return {
        file: path.join("runs", "ledger", path.basename(newest.file)),
        lines: whole.slice(-lines).map((l) => (l.length > LEDGER_LINE_MAX ? l.slice(0, LEDGER_LINE_MAX) + " ...[cut]" : l)),
      };
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

function defaultGh(args: string[], stdin?: string): Promise<GhResult> {
  return new Promise((resolve) => {
    let out = "";
    let err = "";
    let settled = false;
    const done = (r: GhResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn("gh", args, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    } catch (e) {
      return resolve({ code: null, stdout: "", stderr: "", error: (e as Error).message });
    }
    const timer = setTimeout(() => {
      child.kill();
      done({ code: null, stdout: out, stderr: err, error: "gh did not finish within 45 s" });
    }, 45_000);
    child.stdout?.on("data", (c) => (out += c));
    child.stderr?.on("data", (c) => (err += c));
    child.on("error", (e) => done({ code: null, stdout: out, stderr: err, error: e.message }));
    child.on("close", (code) => done({ code, stdout: out, stderr: err }));
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(stdin ?? "");
  });
}

export function defaultDeps(): ReportDeps {
  return {
    now: Date.now,
    workspace: () => path.resolve(getWorkspaceRoot()),
    home: () => os.homedir(),
    osUser: () => {
      try {
        return os.userInfo().username;
      } catch {
        return process.env.USERNAME ?? process.env.USER ?? "";
      }
    },
    hostname: () => os.hostname(),
    deckEnv: readDeckEnv,
    machines: () => listMachines(),
    doctor: (p) => studioDoctor(p),
    latch: automationStatus,
    calls: () => recentCalls(20),
    ledger: defaultLedger,
    versions: defaultVersions,
    gh: defaultGh,
  };
}

async function ghAuthenticated(deps: ReportDeps): Promise<{ authenticated: boolean | "unknown"; detail: string }> {
  const r = await deps.gh(["auth", "status"]);
  if (r.error) return { authenticated: false, detail: `gh could not run: ${r.error}` };
  if (r.code === 0) return { authenticated: true, detail: "gh auth status succeeded" };
  return { authenticated: false, detail: `gh auth status exited ${r.code}` };
}

function fence(text: string, lang = ""): string {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const f = "`".repeat(longest + 1);
  return `${f}${lang}\n${text}\n${f}`;
}

async function safely<T>(label: string, fn: () => T | Promise<T>): Promise<T | { unavailable: string }> {
  try {
    return await fn();
  } catch (err) {
    return { unavailable: `${label} could not be read: ${(err as Error).message}` };
  }
}

function isUnavailable(x: unknown): x is { unavailable: string } {
  return !!x && typeof x === "object" && "unavailable" in x;
}

export function labelsFor(surface: Surface | undefined, source: Source): string[] {
  return [...(surface ? [`surface:${surface}`] : []), `source:${source}`];
}

interface Rendered {
  title: string;
  markdown: string;
  labels: string[];
  redaction: Record<string, number>;
}

async function render(
  p: { title: string; body: string; surface?: Surface; source: Source; extensionVersion?: string; workspace?: string },
  deps: ReportDeps,
): Promise<Rendered> {
  const workspace = p.workspace ? path.resolve(p.workspace) : deps.workspace();
  const labels = labelsFor(p.surface, p.source);

  const versions = await safely("versions", () => deps.versions(p.extensionVersion));
  const doctor = await safely("studio_doctor", () => deps.doctor({ workspace, extensionVersion: p.extensionVersion }));
  const machines = await safely("the machine list", () => deps.machines());
  const latch = await safely("the killswitch latch", () => deps.latch());
  const ledger = await safely("the ledger", () => deps.ledger(workspace, 20));

  const sections: string[] = [];
  sections.push(`#### Versions\n\n${fence(JSON.stringify(versions, null, 2), "json")}`);

  if (isUnavailable(doctor)) {
    sections.push(`#### studio_doctor\n\n${doctor.unavailable}`);
  } else {
    const lines = doctor.checks.map((c) => {
      const tag = c.ok === true ? "ok" : c.ok === false ? "FAIL" : "unknown";
      return `[${tag}] ${c.name}: ${c.saw}${c.fix ? `\n       fix: ${c.fix}` : ""}`;
    });
    sections.push(`#### studio_doctor\n\n${doctor.summary}\n\n${fence(lines.join("\n"), "text")}`);
  }

  if (isUnavailable(machines)) {
    sections.push(`#### Machines\n\n${machines.unavailable}`);
  } else {
    // Names, kinds and os only: no hosts, no users, no ports.
    const list = machines.map((m) => `- ${m.name}: kind ${m.kind}, os ${m.os}`).join("\n");
    sections.push(`#### Machines (kind and os only)\n\n${list || "none registered"}`);
  }

  if (isUnavailable(latch)) {
    sections.push(`#### Killswitch latch\n\n${latch.unavailable}`);
  } else {
    const view = {
      armed: latch.armed,
      stoppedSince: latch.stoppedSince,
      stoppedBy: latch.stoppedBy,
      reason: latch.reason,
      machinesStopped: latch.machinesStopped,
    };
    sections.push(`#### Killswitch latch\n\n${fence(JSON.stringify(view, null, 2), "json")}`);
  }

  if (!isUnavailable(ledger) && ledger && ledger.lines.length) {
    sections.push(`#### Last ${ledger.lines.length} ledger line(s), from ${ledger.file}\n\n${fence(ledger.lines.join("\n"), "text")}`);
  } else {
    const calls = deps.calls();
    const why = isUnavailable(ledger) ? ledger.unavailable : "no runs/ledger/*.ndjson in the workspace";
    const rows = calls.map(
      (c) =>
        `${c.at} ${c.tool} ${c.ok ? "ok" : "FAILED"} ${c.durationMs} ms` +
        (c.error ? ` | ${c.error}` : "") +
        (c.reportId ? ` | ${c.reportId}` : ""),
    );
    sections.push(
      `#### Recent calls (this server process's own ring; ${why})\n\n` +
        (rows.length ? fence(rows.join("\n"), "text") : "No calls recorded since this server started. A call that threw carries a `[DPS report id: ...]` in its error text."),
    );
  }

  const generated = new Date(deps.now()).toISOString();
  const markdown = [
    p.body.trim(),
    "",
    "---",
    "",
    "<details>",
    `<summary>Diagnostic bundle (redacted, generated ${generated})</summary>`,
    "",
    `Filed by: ${p.source} via studio_reportIssue. Surface: ${p.surface ?? "not stated"}.`,
    "",
    sections.join("\n\n"),
    "",
    "</details>",
    "",
    `<sub>Labels requested: ${labels.map((l) => `\`${l}\``).join(", ")}. Redaction removes IP addresses, home and workspace paths, deck.env values, the OS user name, machine hosts, email addresses and token shapes. It cannot catch what it was never told, so a human reads this before it is posted.</sub>`,
    "",
  ].join("\n");

  const env = deps.deckEnv();
  const machineRows = isUnavailable(machines) ? [] : machines;
  const spec: RedactionSpec = {
    ips: [env.DECK_IP].filter((x): x is string => !!x),
    users: [env.DECK_USER, deps.osUser(), ...machineRows.map((m) => m.user)].filter((x): x is string => !!x),
    hosts: [deps.hostname(), ...machineRows.map((m) => m.host)].filter((x): x is string => !!x),
    workspace,
    home: deps.home(),
  };
  const body = redact(markdown, spec);
  const title = redact(p.title.trim(), spec);
  const counts = { ...body.counts };
  for (const [k, v] of Object.entries(title.counts)) counts[k] = (counts[k] ?? 0) + v;
  return { title: title.text, markdown: body.text, labels, redaction: counts };
}

// ---------------------------------------------------------------------------
// The tokens: what this server has shown, and will post
// ---------------------------------------------------------------------------

interface Shown {
  title: string;
  markdown: string;
  labels: string[];
  inputsHash: string;
  at: number;
}

const SHOWN_MAX = 8;
const SHOWN_TTL_MS = 60 * 60_000;
const shown = new Map<string, Shown>();

export function clearShownRenders(): void {
  shown.clear();
}

function sha(...parts: string[]): string {
  const h = crypto.createHash("sha256");
  for (const p of parts) h.update(p).update("\0");
  return h.digest("hex");
}

export function tokenFor(title: string, markdown: string, labels: string[]): string {
  return sha(title, markdown, labels.join(",")).slice(0, 16);
}

// ---------------------------------------------------------------------------
// The prefilled URL
// ---------------------------------------------------------------------------

const URL_MAX = 7000;

export function prefilledUrl(title: string, markdown: string, labels: string[]): { url: string; truncated: boolean } {
  const build = (body: string): string =>
    `https://github.com/${ISSUE_REPO}/issues/new?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}&labels=${labels.map(encodeURIComponent).join(",")}`;
  const whole = build(markdown);
  if (whole.length <= URL_MAX) return { url: whole, truncated: false };
  const note = "\n\n[The diagnostic bundle did not fit in this link. Paste the full text from the editor or clipboard.]";
  let lo = 0;
  let hi = markdown.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (build(markdown.slice(0, mid) + note).length <= URL_MAX) lo = mid;
    else hi = mid - 1;
  }
  return { url: build(markdown.slice(0, lo) + note), truncated: true };
}

// ---------------------------------------------------------------------------
// The tool
// ---------------------------------------------------------------------------

export interface ReportIssueParams {
  title: string;
  body: string;
  surface?: string;
  /** Who is filing. MCP callers are agents (the default); the editor command passes "human". */
  source?: string;
  dryRun?: boolean;
  confirmToken?: string;
  extensionVersion?: string;
  workspace?: string;
}

export interface ReportIssueResult {
  dryRun: boolean;
  posted: boolean;
  title: string;
  /** The exact text that is (or would be) the issue body. */
  markdown: string;
  labels: string[];
  confirmToken: string;
  redaction: { replacements: number; byKind: Record<string, number> };
  gh: { authenticated: boolean | "unknown"; detail: string };
  /** A link that opens a prefilled new-issue page. Opening it posts nothing; the person presses Submit. */
  prefilledUrl: string;
  urlTruncated: boolean;
  /** Post only: how it went out. */
  via?: "gh" | "url";
  issueUrl?: string;
  labelsApplied?: boolean;
  summary: string;
}

const TITLE_MAX = 200;
const BODY_MAX = 20_000;

function validate(p: ReportIssueParams): { title: string; body: string; surface?: Surface; source: Source } {
  const title = typeof p.title === "string" ? p.title.trim() : "";
  const body = typeof p.body === "string" ? p.body.trim() : "";
  if (!title) throw new Error("studio_reportIssue needs a title.");
  if (!body) throw new Error("studio_reportIssue needs a body: say what happened, what you expected, and what you did.");
  if (title.length > TITLE_MAX) throw new Error(`The title is ${title.length} characters; keep it under ${TITLE_MAX}.`);
  if (body.length > BODY_MAX) throw new Error(`The body is ${body.length} characters; keep it under ${BODY_MAX} (the bundle is added on top).`);
  let surface: Surface | undefined;
  if (p.surface != null && p.surface !== "") {
    if (!(SURFACES as readonly string[]).includes(p.surface)) {
      throw new Error(`surface must be one of ${SURFACES.join(", ")}; got ${JSON.stringify(p.surface)}.`);
    }
    surface = p.surface as Surface;
  }
  const source = p.source == null || p.source === "" ? "agent" : p.source;
  if (source !== "agent" && source !== "human") throw new Error(`source must be "agent" or "human"; got ${JSON.stringify(p.source)}.`);
  return { title, body, surface, source };
}

export async function reportIssue(params: ReportIssueParams, deps: ReportDeps = defaultDeps()): Promise<ReportIssueResult> {
  const input = validate(params);
  const dryRun = params.dryRun !== false;
  const inputsHash = sha(input.title, input.body, input.surface ?? "", input.source);
  const gh = await ghAuthenticated(deps);

  // Forget what has gone stale, whichever branch this is.
  const now = deps.now();
  for (const [k, v] of shown) if (now - v.at > SHOWN_TTL_MS) shown.delete(k);

  if (dryRun) {
    const r = await render({ ...input, extensionVersion: params.extensionVersion, workspace: params.workspace }, deps);
    const confirmToken = tokenFor(r.title, r.markdown, r.labels);
    shown.set(confirmToken, { title: r.title, markdown: r.markdown, labels: r.labels, inputsHash, at: now });
    while (shown.size > SHOWN_MAX) shown.delete(shown.keys().next().value as string);
    const link = prefilledUrl(r.title, r.markdown, r.labels);
    const total = Object.values(r.redaction).reduce((a, b) => a + b, 0);
    return {
      dryRun: true,
      posted: false,
      title: r.title,
      markdown: r.markdown,
      labels: r.labels,
      confirmToken,
      redaction: { replacements: total, byKind: r.redaction },
      gh,
      prefilledUrl: link.url,
      urlTruncated: link.truncated,
      summary:
        `Nothing was posted. Read the markdown, then call again with dryRun: false and confirmToken "${confirmToken}" ` +
        `to post (${gh.authenticated === true ? "through gh" : "gh is not authenticated, so you would get a prefilled link instead"}). ` +
        `${total} value(s) were redacted; redaction cannot catch what it does not recognise.`,
    };
  }

  const token = params.confirmToken?.trim();
  if (!token) {
    throw new Error(
      "Not posted: dryRun: false needs a confirmToken, and the token comes from a dry run (dryRun defaults to true). " +
        "Call without dryRun first, read the markdown it returns, then pass its confirmToken.",
    );
  }
  const was = shown.get(token);
  if (!was) {
    throw new Error(
      "Not posted: this server has not shown a render with that confirmToken (tokens last one hour and do not survive a server restart). " +
        "Run a dry run again and read the new text.",
    );
  }
  if (was.inputsHash !== inputsHash) {
    throw new Error(
      "Not posted: the title, body, surface or source differ from the ones the confirmToken was issued for. " +
        "What gets posted is what was shown, so run a dry run again with the text you mean.",
    );
  }
  if (tokenFor(was.title, was.markdown, was.labels) !== token) {
    throw new Error("Not posted: the stored render no longer matches its token. Run a dry run again.");
  }

  const link = prefilledUrl(was.title, was.markdown, was.labels);
  const base = {
    dryRun: false,
    title: was.title,
    markdown: was.markdown,
    labels: was.labels,
    confirmToken: token,
    redaction: { replacements: 0, byKind: {} as Record<string, number> },
    gh,
    prefilledUrl: link.url,
    urlTruncated: link.truncated,
  };

  if (gh.authenticated !== true) {
    return {
      ...base,
      posted: false,
      via: "url",
      summary: `Not posted: ${gh.detail}. Open prefilledUrl, check it, and press Submit yourself${link.truncated ? " (the link is cut short; paste the full markdown into the body)" : ""}.`,
    };
  }

  const create = (withLabels: boolean): Promise<GhResult> =>
    deps.gh(
      [
        "issue", "create", "--repo", ISSUE_REPO, "--title", was.title, "--body-file", "-",
        ...(withLabels ? was.labels.flatMap((l) => ["--label", l]) : []),
      ],
      was.markdown,
    );
  let labelsApplied = true;
  let r = await create(true);
  if (r.code !== 0 && /label/i.test(r.stderr) && /not found|could not add|does not exist/i.test(r.stderr)) {
    // gh creates nothing when a label is missing, so this retry cannot double-post.
    labelsApplied = false;
    r = await create(false);
  }
  if (r.code !== 0) {
    return {
      ...base,
      posted: false,
      via: "gh",
      summary: `gh issue create failed (${r.error ?? `exit ${r.code}`}): ${(r.stderr || r.stdout).trim().split(/\r?\n/)[0] ?? ""}. Nothing was posted; prefilledUrl is the fallback.`,
    };
  }
  const issueUrl = r.stdout.match(/https:\/\/github\.com\/\S+/)?.[0] ?? r.stdout.trim();
  shown.delete(token);
  return {
    ...base,
    posted: true,
    via: "gh",
    issueUrl,
    labelsApplied,
    summary: `Posted ${issueUrl}${labelsApplied ? "" : " without labels (they do not exist in the repo yet; they are listed at the bottom of the body)"}.`,
  };
}

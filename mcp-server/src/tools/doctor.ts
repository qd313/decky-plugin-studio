/**
 * studio_doctor: a self-check for Decky Plugin Studio itself.
 *
 * Setup drift has cost real sessions: Claude Code reads `.mcp.json` and not
 * `mcp.json`; the DPS tools pointed at a path that no longer existed; a second
 * window killed its own server on a shared port; the four version pins moved
 * apart. Every check here reads state and reports it. None of them writes,
 * presses or contacts a Deck.
 *
 * Rule for every check: an error inside it is `ok: "unknown"` with the error
 * text, never a pass, and never stops the other checks.
 */
import fs from "fs";
import net from "net";
import http from "http";
import path from "path";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";

import { getDeckEnvPath, readDeckEnv } from "../config.js";
import { listMachines, getMachinesPath } from "../machines.js";
import { automationStatus } from "../deck/killswitch.js";
import { findBridgeTool } from "../deck/bridgeTools.js";
import { isIngestRunning } from "../ingest/server.js";
import { verifyPackagedScripts } from "./captureOrchestrator.js";

export type CheckVerdict = true | false | "unknown";

export interface DoctorCheck {
  name: string;
  ok: CheckVerdict;
  /** What the check actually looked at and found. */
  saw: string;
  /** What to do about it. Empty when ok. */
  fix: string;
}

export interface DoctorReport {
  checks: DoctorCheck[];
  okCount: number;
  failCount: number;
  unknownCount: number;
  summary: string;
}

export type PythonProbe = "ok" | "missing" | "no-python";

export interface DoctorContext {
  workspace: string;
  /** The extension's version, when the caller knows it (the VS Code command does). */
  extensionVersion?: string;
  /** Root of the running mcp-server tree (the folder holding package.json and dist/). */
  mcpServerRoot: string;
  ingestPort: number;
  findBridgeTool: (name: string) => string | null;
  probePython: (moduleName: string) => PythonProbe;
  /** Whether this process is the one listening on the ingest port. */
  ingestRunningHere: () => boolean;
}

export type CheckFn = (ctx: DoctorContext) => DoctorCheck | Promise<DoctorCheck>;

function pass(name: string, saw: string): DoctorCheck {
  return { name, ok: true, saw, fix: "" };
}
function fail(name: string, saw: string, fix: string): DoctorCheck {
  return { name, ok: false, saw, fix };
}
function unknown(name: string, saw: string, fix = ""): DoctorCheck {
  return { name, ok: "unknown", saw, fix };
}

function readJson(file: string): unknown {
  return JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, ""));
}

function versionOf(pkgFile: string): string | null {
  try {
    const v = (readJson(pkgFile) as { version?: unknown }).version;
    return typeof v === "string" ? v : null;
  } catch {
    return null;
  }
}

/** The package.json that owns a file: nearest ancestor holding one. */
function owningPackageJson(file: string): string | null {
  let dir = path.dirname(file);
  for (let i = 0; i < 6; i++) {
    const cand = path.join(dir, "package.json");
    if (fs.existsSync(cand)) return cand;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

// ---- 1. the MCP config the IDE will read -----------------------------------

const MCP_CONFIGS = [".mcp.json", "mcp.json", path.join(".cursor", "mcp.json"), path.join(".vscode", "mcp.json")];

function expectedExtensionVersion(ctx: DoctorContext): { version: string; source: string } | null {
  if (ctx.extensionVersion) return { version: ctx.extensionVersion, source: "the extension" };
  for (const root of [ctx.workspace, path.join(ctx.mcpServerRoot, "..")]) {
    const v = versionOf(path.join(root, "extension", "package.json"));
    if (v) return { version: v, source: path.join(root, "extension", "package.json") };
  }
  const own = versionOf(path.join(ctx.mcpServerRoot, "package.json"));
  return own ? { version: own, source: "the running server's own package.json" } : null;
}

type McpServers = Record<string, { command?: string; args?: unknown[] }>;

export const checkMcpConfig: CheckFn = (ctx) => {
  const name = "MCP config points at a real server";
  const found: string[] = [];
  const problems: string[] = [];
  const fixes: string[] = [];
  const expected = expectedExtensionVersion(ctx);

  for (const rel of MCP_CONFIGS) {
    const file = path.join(ctx.workspace, rel);
    if (!fs.existsSync(file)) continue;
    let doc: { mcpServers?: McpServers; servers?: McpServers };
    try {
      doc = readJson(file) as typeof doc;
    } catch (err) {
      problems.push(`${file} is not valid JSON (${(err as Error).message})`);
      fixes.push(`Fix the JSON in ${file}.`);
      continue;
    }
    const servers = doc.mcpServers ?? doc.servers ?? {};
    for (const [serverName, entry] of Object.entries(servers)) {
      const parts = [entry?.command, ...(Array.isArray(entry?.args) ? entry.args : [])].filter(
        (x): x is string => typeof x === "string",
      );
      const entryFile = parts.find((p) => /decky|studio/i.test(p) && /\.(c|m)?js$/.test(p));
      if (!entryFile) continue;
      found.push(`${rel}: ${serverName} -> ${entryFile}`);
      const resolved = path.resolve(ctx.workspace, entryFile);
      if (!fs.existsSync(resolved)) {
        problems.push(`${rel}: "${serverName}" points at ${resolved}, which does not exist`);
        fixes.push(
          `In ${file}, change the "${serverName}" path to the mcp-server entry file that exists (dist/index.js of the current install).`,
        );
        continue;
      }
      const pkg = owningPackageJson(resolved);
      const v = pkg ? versionOf(pkg) : null;
      if (expected && v && v !== expected.version) {
        problems.push(`${rel}: "${serverName}" runs server ${v} but ${expected.source} is ${expected.version}`);
        fixes.push(
          `In ${file}, point "${serverName}" at the ${expected.version} build (${path.join(ctx.mcpServerRoot, "dist", "index.js")}), or reinstall.`,
        );
      }
    }
  }
  if (problems.length) return fail(name, problems.join("; "), fixes.join(" "));
  if (found.length === 0) {
    return unknown(
      name,
      `none of ${MCP_CONFIGS.join(", ")} in ${ctx.workspace} names a decky-plugin-studio server (a VS Code user setting cannot be read from here)`,
      "If your agent cannot see the DPS tools, add the server to .mcp.json (Claude Code reads .mcp.json, not mcp.json) or run Decky: Init Pack.",
    );
  }
  return pass(name, found.join("; "));
};

// ---- 2. the four version pins ----------------------------------------------

export const checkVersionPins: CheckFn = (ctx) => {
  const name = "Version pins agree";
  const roots = [ctx.workspace, path.join(ctx.mcpServerRoot, "..")];
  const root = roots.find((r) => fs.existsSync(path.join(r, "mcp-server", "src", "index.ts")));
  if (!root) {
    return unknown(
      name,
      `${ctx.workspace} is not a Decky Plugin Studio checkout (no mcp-server/src/index.ts), so there are no pins to compare`,
    );
  }
  const pins: Array<[string, string | null]> = [
    ["package.json", versionOf(path.join(root, "package.json"))],
    ["extension/package.json", versionOf(path.join(root, "extension", "package.json"))],
    ["mcp-server/package.json", versionOf(path.join(root, "mcp-server", "package.json"))],
  ];
  const src = fs.readFileSync(path.join(root, "mcp-server", "src", "index.ts"), "utf8");
  const m = src.match(/SERVER_INFO\s*=\s*\{[^}]*version:\s*"([^"]+)"/);
  pins.push(["SERVER_INFO in mcp-server/src/index.ts", m ? m[1] : null]);
  const unread = pins.filter(([, v]) => v === null).map(([n]) => n);
  if (unread.length) return unknown(name, `could not read: ${unread.join(", ")}`);
  const distinct = new Set(pins.map(([, v]) => v));
  const listing = pins.map(([n, v]) => `${n}=${v}`).join(", ");
  if (distinct.size > 1) {
    return fail(name, listing, "Move all four to the same version in one commit; the server otherwise reports a stale number over MCP.");
  }
  return pass(name, listing);
};

// ---- 3. ports --------------------------------------------------------------

function tryListen(port: number): Promise<"free" | "in-use" | string> {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once("error", (err: NodeJS.ErrnoException) => resolve(err.code === "EADDRINUSE" ? "in-use" : err.message));
    s.listen(port, "127.0.0.1", () => s.close(() => resolve("free")));
  });
}

function whoAnswers(port: number): Promise<string> {
  return new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port, path: "/health", timeout: 1000, agent: false }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => {
        try {
          resolve(
            (JSON.parse(body) as { ok?: boolean }).ok
              ? "another Decky Plugin Studio server (it answers /health)"
              : "an unknown program",
          );
        } catch {
          resolve("an unknown program");
        }
      });
    });
    req.on("timeout", () => {
      req.destroy();
      resolve("an unknown program");
    });
    req.on("error", () => resolve("an unknown program"));
  });
}

export const checkPorts: CheckFn = async (ctx) => {
  const name = "Ingest port is ours";
  const port = ctx.ingestPort;
  if (ctx.ingestRunningHere()) {
    return pass(name, `this server is listening on ingest port ${port} (the only port the server listens on)`);
  }
  const r = await tryListen(port);
  if (r === "free") {
    return pass(name, `ingest port ${port} is free; nothing else holds it (the only port the server listens on)`);
  }
  if (r === "in-use") {
    const who = await whoAnswers(port);
    return fail(
      name,
      `ingest port ${port} is held by ${who}, and not by this server, so debug ingest is off here`,
      "Close the other window or program, or set DEBUG_INGEST_PORT to a free port for this one.",
    );
  }
  return unknown(name, `could not test port ${port}: ${r}`);
};

// ---- 4. bridge scripts and Python ------------------------------------------

export function defaultProbePython(moduleName: string): PythonProbe {
  let sawPython = false;
  for (const exe of ["python", "python3", "py"]) {
    const r = spawnSync(exe, ["-c", `import ${moduleName}`], { encoding: "utf8", timeout: 8000 });
    if (r.error) continue;
    sawPython = true;
    if (r.status === 0) return "ok";
  }
  return sawPython ? "missing" : "no-python";
}

export const checkScriptsAndPython: CheckFn = (ctx) => {
  const name = "Bridge scripts and Python";
  const problems: string[] = [];
  const fixes: string[] = [];
  const notes: string[] = [];
  let unsure = false;

  for (const tool of ["pad.py", "chord.py", "vpad.py"]) {
    const p = ctx.findBridgeTool(tool);
    if (!p) {
      problems.push(`bridge/tools/${tool} not found from the running build`);
      fixes.push(`Reinstall or rebuild so bridge/tools/${tool} ships beside the server.`);
    } else notes.push(tool);
  }
  const scripts = verifyPackagedScripts(ctx.mcpServerRoot);
  if (!scripts.ok) {
    const detail = scripts.missing?.length
      ? `missing ${scripts.missing.join(", ")} in ${scripts.scriptsDir}`
      : (scripts.error ?? "unresolved");
    problems.push(`capture scripts: ${detail}`);
    fixes.push("Run pnpm build in mcp-server (it copies the scripts into dist/scripts) or reinstall the extension.");
  } else notes.push("capture scripts");

  const modules: Array<[string, string]> = [["serial", "the bridge (pyserial)"]];
  if (process.platform === "win32") modules.push(["vgamepad", "the virtual pad"]);
  for (const [mod, why] of modules) {
    const r = ctx.probePython(mod);
    if (r === "no-python") {
      unsure = true;
      notes.push(`no Python on PATH, could not test import ${mod}`);
    } else if (r === "missing") {
      problems.push(`Python cannot import ${mod}, needed for ${why}`);
      fixes.push(`pip install ${mod === "serial" ? "pyserial" : mod}`);
    } else notes.push(`import ${mod} works`);
  }
  if (problems.length) return fail(name, problems.join("; "), fixes.join(" "));
  if (unsure) return unknown(name, notes.join("; "), "Install Python and put it on PATH to use the bridge or the virtual pad.");
  return pass(name, notes.join("; "));
};

// ---- 5. machines.json ------------------------------------------------------

export const checkMachines: CheckFn = () => {
  const name = "machines.json is valid";
  const file = getMachinesPath();
  try {
    const machines = listMachines();
    const bad = machines.filter((m) => m.name !== "deck" && !m.local && !m.host && m.press !== "vigem").map((m) => m.name);
    if (bad.length) {
      return fail(
        name,
        `machine(s) ${bad.join(", ")} are remote but have no host`,
        `Add a "host" to each in ${file}, or mark them "local": true.`,
      );
    }
    const list = machines.map((m) => `${m.name} (${m.kind}, press ${m.press})`).join(", ");
    return pass(name, `${machines.length} machine(s) parse: ${list}${fs.existsSync(file) ? "" : "; no machines.json, so only deck"}`);
  } catch (err) {
    return fail(name, (err as Error).message, `Fix or delete ${file}.`);
  }
};

// ---- 6. deck.env -----------------------------------------------------------

export const checkDeckEnv: CheckFn = () => {
  const name = "deck.env has the real Deck's address";
  const env = readDeckEnv();
  const missing = ["DECK_IP", "DECK_USER"].filter((k) => !env[k]);
  if (missing.length === 0) return pass(name, `DECK_IP=${env.DECK_IP}, DECK_USER=${env.DECK_USER}`);
  return pass(
    name,
    `${missing.join(" and ")} not set in ${getDeckEnvPath()}: the real Deck is unconfigured (fine for a stand-in-only setup)`,
  );
};

// ---- 7. killswitch ---------------------------------------------------------

export const checkKillswitch: CheckFn = () => {
  const name = "Killswitch state";
  const s = automationStatus();
  const per = s.machinesStopped.map((m) => m.machine);
  if (!s.armed) {
    return fail(
      name,
      s.summary,
      "Automation was stopped by a person. Re-arm it yourself (status bar, Decky: Arm Deck Automation, or pnpm run arm) when it is safe.",
    );
  }
  if (per.length) {
    return fail(name, `armed overall, but stopped on: ${per.join(", ")}`, `Re-arm (Decky: Arm Deck Automation) when ${per.join(", ")} is safe to drive.`);
  }
  return pass(name, s.summary);
};

// ---- runner ----------------------------------------------------------------

export const ALL_CHECKS: Array<[string, CheckFn]> = [
  ["MCP config points at a real server", checkMcpConfig],
  ["Version pins agree", checkVersionPins],
  ["Ingest port is ours", checkPorts],
  ["Bridge scripts and Python", checkScriptsAndPython],
  ["machines.json is valid", checkMachines],
  ["deck.env has the real Deck's address", checkDeckEnv],
  ["Killswitch state", checkKillswitch],
];

/** Run each check on its own; an exception becomes `unknown` for that check only. */
export async function runChecks(
  ctx: DoctorContext,
  checks: Array<[string, CheckFn]> = ALL_CHECKS,
): Promise<DoctorReport> {
  const out: DoctorCheck[] = [];
  for (const [name, fn] of checks) {
    try {
      out.push(await fn(ctx));
    } catch (err) {
      out.push(unknown(name, `the check itself failed: ${(err as Error).message}`));
    }
  }
  const okCount = out.filter((c) => c.ok === true).length;
  const failCount = out.filter((c) => c.ok === false).length;
  const unknownCount = out.length - okCount - failCount;
  // Failures first, then unknowns, then passes.
  const rank = (c: DoctorCheck): number => (c.ok === false ? 0 : c.ok === "unknown" ? 1 : 2);
  out.sort((a, b) => rank(a) - rank(b));
  return {
    checks: out,
    okCount,
    failCount,
    unknownCount,
    summary: `${okCount} ok, ${failCount} failing, ${unknownCount} could not be checked`,
  };
}

export function defaultContext(workspace?: string, extensionVersion?: string): DoctorContext {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return {
    workspace: path.resolve(workspace || process.env.DECKY_STUDIO_WORKSPACE || process.cwd()),
    extensionVersion,
    mcpServerRoot: path.resolve(here, "..", ".."),
    ingestPort: Number(process.env.DEBUG_INGEST_PORT ?? 7682),
    findBridgeTool,
    probePython: defaultProbePython,
    ingestRunningHere: isIngestRunning,
  };
}

export function studioDoctor(params: { workspace?: string; extensionVersion?: string } = {}): Promise<DoctorReport> {
  return runChecks(defaultContext(params.workspace, params.extensionVersion));
}

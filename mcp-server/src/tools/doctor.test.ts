import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import http from "http";
import net from "net";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

import {
  runChecks,
  checkMcpConfig,
  checkVersionPins,
  checkPorts,
  checkScriptsAndPython,
  checkMachines,
  checkDeckEnv,
  checkKillswitch,
  type DoctorContext,
  type CheckFn,
} from "./doctor.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const realMcpRoot = path.resolve(here, "..", "..");

function tmp(label: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `doctor-${label}-`));
}
function write(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

function ctxFor(workspace: string, over: Partial<DoctorContext> = {}): DoctorContext {
  return {
    workspace,
    mcpServerRoot: realMcpRoot,
    ingestPort: 0,
    findBridgeTool: (n) => `/fake/${n}`,
    probePython: () => "ok",
    ingestRunningHere: () => false,
    ...over,
  };
}

/** Point the config dir (~/.config/decky-plugin-studio) at a temp home. */
function withHome<T>(fn: (home: string) => T | Promise<T>): Promise<T> {
  const home = tmp("home");
  const saved = { h: process.env.HOME, u: process.env.USERPROFILE, ip: process.env.DECK_IP, du: process.env.DECK_USER };
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  delete process.env.DECK_IP;
  delete process.env.DECK_USER;
  const restore = (): void => {
    const set = (k: string, v: string | undefined): void => {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    };
    set("HOME", saved.h);
    set("USERPROFILE", saved.u);
    set("DECK_IP", saved.ip);
    set("DECK_USER", saved.du);
  };
  return Promise.resolve(fn(home)).finally(restore);
}

function repoLayout(versions: { root: string; ext: string; mcp: string; info: string }): string {
  const ws = tmp("repo");
  write(path.join(ws, "package.json"), JSON.stringify({ version: versions.root }));
  write(path.join(ws, "extension", "package.json"), JSON.stringify({ version: versions.ext }));
  write(path.join(ws, "mcp-server", "package.json"), JSON.stringify({ version: versions.mcp }));
  write(
    path.join(ws, "mcp-server", "src", "index.ts"),
    `const SERVER_INFO = { name: "decky-plugin-studio", version: "${versions.info}" };\n`,
  );
  return ws;
}

test("version pins: clean layout passes, one edited pin fails and names it", () => {
  const ok = repoLayout({ root: "1.2.3", ext: "1.2.3", mcp: "1.2.3", info: "1.2.3" });
  const good = checkVersionPins(ctxFor(ok)) as { ok: unknown };
  assert.equal(good.ok, true);

  const bad = repoLayout({ root: "1.2.3", ext: "1.2.3", mcp: "1.2.3", info: "1.2.2" });
  const res = checkVersionPins(ctxFor(bad)) as { ok: unknown; saw: string };
  assert.equal(res.ok, false);
  assert.match(res.saw, /SERVER_INFO in mcp-server\/src\/index.ts=1\.2\.2/);
});

test("version pins: a workspace that is not a DPS checkout is unknown, not a pass", () => {
  const ws = tmp("consumer");
  const prevRoot = realMcpRoot;
  const res = checkVersionPins(ctxFor(ws, { mcpServerRoot: path.join(ws, "nowhere", "mcp-server") })) as { ok: unknown };
  assert.equal(res.ok, "unknown");
  assert.ok(prevRoot);
});

test("mcp config: a .mcp.json naming a missing entry file fails with the path to change", () => {
  const ws = tmp("mcp");
  write(
    path.join(ws, ".mcp.json"),
    JSON.stringify({ mcpServers: { "decky-plugin-studio": { command: "node", args: ["gone/decky-studio/dist/index.js"] } } }),
  );
  const res = checkMcpConfig(ctxFor(ws)) as { ok: unknown; saw: string; fix: string };
  assert.equal(res.ok, false);
  assert.match(res.saw, /does not exist/);
  assert.ok(res.fix.includes(path.join(ws, ".mcp.json")));
});

test("mcp config: an entry file that exists with a matching version passes; a stale one fails", () => {
  const ws = tmp("mcp2");
  const server = path.join(ws, "server");
  write(path.join(server, "package.json"), JSON.stringify({ version: "0.3.0" }));
  write(path.join(server, "dist", "decky-studio.js"), "//");
  write(
    path.join(ws, ".mcp.json"),
    JSON.stringify({ mcpServers: { dps: { command: "node", args: [path.join(server, "dist", "decky-studio.js")] } } }),
  );
  assert.equal((checkMcpConfig(ctxFor(ws, { extensionVersion: "0.3.0" })) as { ok: unknown }).ok, true);
  const stale = checkMcpConfig(ctxFor(ws, { extensionVersion: "0.3.1" })) as { ok: unknown; saw: string };
  assert.equal(stale.ok, false);
  assert.match(stale.saw, /runs server 0\.3\.0 but the extension is 0\.3\.1/);
});

test("mcp config: no config at all is unknown, and the fix mentions .mcp.json", () => {
  const res = checkMcpConfig(ctxFor(tmp("empty"))) as { ok: unknown; fix: string };
  assert.equal(res.ok, "unknown");
  assert.match(res.fix, /\.mcp\.json/);
});

test("scripts: clean build passes; a missing pad.py or chord.py fails", () => {
  const good = checkScriptsAndPython(ctxFor(tmp("s"))) as { ok: unknown; saw: string };
  assert.equal(good.ok, true, good.saw);

  const bad = checkScriptsAndPython(
    ctxFor(tmp("s"), { findBridgeTool: (n) => (n === "chord.py" ? null : `/fake/${n}`) }),
  ) as { ok: unknown; saw: string };
  assert.equal(bad.ok, false);
  assert.match(bad.saw, /chord\.py not found/);
});

test("scripts: capture scripts missing from the build fail", () => {
  const empty = tmp("noscripts");
  const res = checkScriptsAndPython(ctxFor(tmp("s"), { mcpServerRoot: empty })) as { ok: unknown; saw: string };
  assert.equal(res.ok, false);
  assert.match(res.saw, /capture scripts/);
});

test("python: absent is unknown, an import that fails is a failure", () => {
  const none = checkScriptsAndPython(ctxFor(tmp("p"), { probePython: () => "no-python" })) as { ok: unknown };
  assert.equal(none.ok, "unknown");
  const missing = checkScriptsAndPython(ctxFor(tmp("p"), { probePython: () => "missing" })) as { ok: unknown; fix: string };
  assert.equal(missing.ok, false);
  assert.match(missing.fix, /pip install/);
});

test("machines.json: absent is fine, invalid JSON fails, a remote stand-in with no host fails", async () => {
  await withHome(async (home) => {
    assert.equal((await checkMachines(ctxFor(tmp("m")))).ok, true);
    const file = path.join(home, ".config", "decky-plugin-studio", "machines.json");
    write(file, "{ not json");
    const bad = await checkMachines(ctxFor(tmp("m")));
    assert.equal(bad.ok, false);
    assert.match(bad.saw, /not valid JSON/);
    write(file, JSON.stringify({ machines: { vm: { kind: "standin", os: "bazzite", press: "uinput" } } }));
    const nohost = await checkMachines(ctxFor(tmp("m")));
    assert.equal(nohost.ok, false);
    assert.match(nohost.saw, /vm/);
    write(file, JSON.stringify({ machines: { vm: { kind: "standin", os: "bazzite", press: "uinput", host: "10.0.0.5" } } }));
    assert.equal((await checkMachines(ctxFor(tmp("m")))).ok, true);
  });
});

test("deck.env: unset is ok with a note, not a failure", async () => {
  await withHome(async () => {
    const res = await checkDeckEnv(ctxFor(tmp("e")));
    assert.equal(res.ok, true);
    assert.match(res.saw, /unconfigured/);
  });
});

test("killswitch: armed passes, a stop latch fails", async () => {
  await withHome(async (home) => {
    assert.equal((await checkKillswitch(ctxFor(tmp("k")))).ok, true);
    write(
      path.join(home, ".config", "decky-plugin-studio", "automation-stop.json"),
      JSON.stringify({ at: new Date().toISOString(), by: "cli", pid: 1, host: "h" }),
    );
    const res = await checkKillswitch(ctxFor(tmp("k")));
    assert.equal(res.ok, false);
    assert.match(res.saw, /STOPPED/);
  });
});

test("ports: free passes; a port someone else holds fails", async () => {
  // A stand-in for a second Studio server: answers /health the way ingest does.
  const holder = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, count: 0 }));
  });
  await new Promise<void>((r) => holder.listen(0, "127.0.0.1", r));
  const busy = (holder.address() as net.AddressInfo).port;
  try {
    const bad = await checkPorts(ctxFor(tmp("port"), { ingestPort: busy }));
    assert.equal(bad.ok, false);
    assert.match(bad.saw, /another Decky Plugin Studio server/);
    assert.match(bad.fix, /DEBUG_INGEST_PORT/);
  } finally {
    holder.closeAllConnections();
    await new Promise<void>((r) => holder.close(() => r()));
  }
  const free = await checkPorts(ctxFor(tmp("port"), { ingestPort: busy }));
  assert.equal(free.ok, true);
  const mine = await checkPorts(ctxFor(tmp("port"), { ingestPort: busy, ingestRunningHere: () => true }));
  assert.equal(mine.ok, true);
});

test("a check that throws is unknown for that check and the others still run", async () => {
  const boom: CheckFn = () => {
    throw new Error("kaboom");
  };
  const fine: CheckFn = () => ({ name: "fine", ok: true, saw: "x", fix: "" });
  const report = await runChecks(ctxFor(tmp("r")), [
    ["boom", boom],
    ["fine", fine],
    ["failing", () => ({ name: "failing", ok: false, saw: "y", fix: "z" })],
  ]);
  assert.equal(report.checks.length, 3);
  const b = report.checks.find((c) => c.name === "boom")!;
  assert.equal(b.ok, "unknown");
  assert.match(b.saw, /kaboom/);
  assert.equal(report.okCount, 1);
  assert.equal(report.failCount, 1);
  assert.equal(report.unknownCount, 1);
  assert.equal(report.checks[0].name, "failing", "failures sort first");
});

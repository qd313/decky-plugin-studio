/**
 * Tests for the machine registry (machines.ts).
 *
 * Sandboxed the way killswitch.test.ts is: getConfigDir() derives from
 * os.homedir(), which Node reads from USERPROFILE/HOME at call time, so
 * pointing those at a temp dir moves deck.env and machines.json with them.
 * DECK_IP/DECK_USER in the process environment override deck.env
 * (config.ts HOST_OVERRIDABLE), so they are cleared for the duration.
 */
process.env.DPS_NO_BRIDGE ??= "1";

import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const realEnv = {
  USERPROFILE: process.env.USERPROFILE,
  HOME: process.env.HOME,
  DECK_IP: process.env.DECK_IP,
  DECK_USER: process.env.DECK_USER,
};
const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "dps-machines-"));
process.env.USERPROFILE = tempHome;
process.env.HOME = tempHome;
delete process.env.DECK_IP;
delete process.env.DECK_USER;

const {
  listMachines,
  resolveMachine,
  upsertMachine,
  defaultMachineName,
  getMachinesPath,
  runWithMachine,
  currentMachine,
  currentMachineIfAny,
  normalizeMachine,
  UnknownMachineError,
  MachinesFileError,
  labelOf,
} = await import("./machines.js");
const { writeDeckEnv, getDeckEnvPath } = await import("./config.js");

function assertSandboxed(): void {
  assert.ok(getMachinesPath().startsWith(tempHome), `registry path escaped the sandbox: ${getMachinesPath()}`);
  assert.ok(getDeckEnvPath().startsWith(tempHome), `deck.env path escaped the sandbox: ${getDeckEnvPath()}`);
}

before(() => assertSandboxed());
beforeEach(() => {
  assertSandboxed();
  fs.rmSync(getMachinesPath(), { force: true });
  fs.rmSync(getDeckEnvPath(), { force: true });
});
after(() => {
  process.env.USERPROFILE = realEnv.USERPROFILE;
  process.env.HOME = realEnv.HOME;
  if (realEnv.DECK_IP === undefined) delete process.env.DECK_IP;
  else process.env.DECK_IP = realEnv.DECK_IP;
  if (realEnv.DECK_USER === undefined) delete process.env.DECK_USER;
  else process.env.DECK_USER = realEnv.DECK_USER;
  fs.rmSync(tempHome, { recursive: true, force: true });
});

// ---- the deck entry is deck.env ------------------------------------------

test("with no files at all there is exactly one machine, deck, unconfigured and remote", () => {
  const all = listMachines();
  assert.equal(all.length, 1);
  const deck = all[0];
  assert.equal(deck.name, "deck");
  assert.equal(deck.kind, "deck");
  assert.equal(deck.os, "steamos");
  assert.equal(deck.press, "bridge");
  assert.equal(deck.host, undefined);
  assert.equal(deck.user, "deck");
  // On a Windows host "local" can never default to true; on a SteamOS host
  // with no DECK_IP it would, which is the one concession machines.ts makes.
  if (process.platform === "win32") assert.equal(deck.local, false);
});

test("deck.env supplies the deck's host, user and bridge port, and the environment overrides the file", () => {
  writeDeckEnv({ DECK_IP: "192.0.2.10", DECK_USER: "gamer", DECK_BRIDGE_PORT: "COM9" });
  let deck = resolveMachine("deck");
  assert.equal(deck.host, "192.0.2.10");
  assert.equal(deck.user, "gamer");
  assert.equal(deck.bridgePort, "COM9");

  process.env.DECK_IP = "192.0.2.99";
  try {
    deck = resolveMachine();
    assert.equal(deck.host, "192.0.2.99", "the explicitly set variable wins over the file");
  } finally {
    delete process.env.DECK_IP;
  }
});

test("machines.json may extend the deck entry but cannot override its address", () => {
  writeDeckEnv({ DECK_IP: "192.0.2.10" });
  fs.writeFileSync(
    getMachinesPath(),
    JSON.stringify({ machines: { deck: { host: "10.0.0.1", cdpPort: 9222, note: "the real one" } } }),
  );
  const deck = resolveMachine("deck");
  assert.equal(deck.host, "192.0.2.10", "deck.env is the one source of truth for the Deck's address");
  assert.equal(deck.cdpPort, 9222);
  assert.equal(deck.note, "the real one");
});

// ---- stand-ins -----------------------------------------------------------

test("a stand-in entry gets sensible defaults: standin, bazzite, uinput, user deck", () => {
  fs.writeFileSync(getMachinesPath(), JSON.stringify({ machines: { "standin-1": { host: "standin-1" } } }));
  const m = resolveMachine("standin-1");
  assert.deepEqual(labelOf(m), { name: "standin-1", kind: "standin", os: "bazzite" });
  assert.equal(m.press, "uinput");
  assert.equal(m.local, false);
  assert.equal(m.user, "deck");
  assert.equal(m.host, "standin-1");
});

test("this PC as a Windows stand-in: local, vigem", () => {
  fs.writeFileSync(
    getMachinesPath(),
    JSON.stringify({ machines: { "this-pc": { os: "windows", local: true, press: "vigem", padPort: 7700 } } }),
  );
  const m = resolveMachine("this-pc");
  assert.equal(m.kind, "standin");
  assert.equal(m.os, "windows");
  assert.equal(m.local, true);
  assert.equal(m.press, "vigem");
  assert.equal(m.padPort, 7700);
});

test("entries that cannot work are refused with the field named", () => {
  assert.throws(() => normalizeMachine("x", { os: "windows", press: "vigem", local: false }), /must be local/);
  assert.throws(() => normalizeMachine("x", { os: "windows", press: "uinput", local: true }), /Linux-only/);
  assert.throws(() => normalizeMachine("x", { os: "bazzite", press: "vigem", local: true }), /needs os "windows"/);
  assert.throws(() => normalizeMachine("x", { kind: "robot" as never }), /kind must be/);
  assert.throws(() => normalizeMachine("x", { os: "haiku" as never }), /os must be/);
  assert.throws(() => normalizeMachine("x", { press: "telepathy" as never }), /press must be/);
  assert.throws(() => normalizeMachine("bad name!", {}), /letters, digits/);
  assert.throws(() => normalizeMachine("x", { padPort: 70000 }), /port number/);
  assert.throws(() => normalizeMachine("x", { vm: { hypervisor: "hyperv" as never, name: "v" } }), /hypervisor/);
});

test("an unknown machine names every known one in its error", () => {
  fs.writeFileSync(getMachinesPath(), JSON.stringify({ machines: { "standin-1": { host: "a" }, "standin-2": { host: "b" } } }));
  assert.throws(
    () => resolveMachine("standin-9"),
    (err: unknown) =>
      err instanceof UnknownMachineError && /deck, standin-1, standin-2/.test((err as Error).message),
  );
});

test("a broken machines.json throws rather than silently reading as empty", () => {
  fs.writeFileSync(getMachinesPath(), "{ not json");
  assert.throws(() => listMachines(), MachinesFileError);
  fs.writeFileSync(getMachinesPath(), JSON.stringify({ machines: [1, 2] }));
  assert.throws(() => listMachines(), MachinesFileError);
});

// ---- upsert / remove / default -------------------------------------------

test("upsertMachine validates before writing, writes atomically, and can set the default", () => {
  assert.throws(() => upsertMachine("standin-1", { os: "windows", press: "uinput", local: true }), /Linux-only/);
  assert.equal(fs.existsSync(getMachinesPath()), false, "nothing was written for a bad entry");

  const r = upsertMachine("standin-1", { host: "standin-1", note: "first" }, { makeDefault: true });
  assert.equal(r.machine?.name, "standin-1");
  assert.equal(defaultMachineName(), "standin-1");
  assert.equal(resolveMachine().name, "standin-1", "resolveMachine() with no name follows the default");

  // A second upsert merges onto the first.
  upsertMachine("standin-1", { padPort: 7777 });
  const m = resolveMachine("standin-1");
  assert.equal(m.note, "first");
  assert.equal(m.padPort, 7777);

  const gone = upsertMachine("standin-1", {}, { remove: true });
  assert.equal(gone.machine, null);
  assert.equal(defaultMachineName(), "deck", "removing the default machine falls back to deck");
  assert.throws(() => resolveMachine("standin-1"), UnknownMachineError);
});

test('the "deck" entry cannot be removed', () => {
  assert.throws(() => upsertMachine("deck", {}, { remove: true }), /cannot be removed/);
});

// ---- the per-call context ------------------------------------------------

test("currentMachine() outside any call is the default; inside runWithMachine it is that machine", async () => {
  fs.writeFileSync(getMachinesPath(), JSON.stringify({ machines: { "standin-1": { host: "a" } } }));
  assert.equal(currentMachine().name, "deck");
  assert.equal(currentMachineIfAny(), null);
  const s1 = resolveMachine("standin-1");
  await runWithMachine(s1, async () => {
    assert.equal(currentMachine().name, "standin-1");
    assert.equal(currentMachineIfAny()?.name, "standin-1");
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(currentMachine().name, "standin-1", "survives an await");
  });
  assert.equal(currentMachine().name, "deck");
});

test("two interleaved calls each keep their own machine", async () => {
  fs.writeFileSync(getMachinesPath(), JSON.stringify({ machines: { a: { host: "a" }, b: { host: "b" } } }));
  const seen: string[] = [];
  const run = (name: string, delay: number) =>
    runWithMachine(resolveMachine(name), async () => {
      await new Promise((r) => setTimeout(r, delay));
      seen.push(`${name}:${currentMachine().name}`);
      await new Promise((r) => setTimeout(r, delay));
      seen.push(`${name}:${currentMachine().name}`);
    });
  await Promise.all([run("a", 10), run("b", 3)]);
  assert.deepEqual(seen.sort(), ["a:a", "a:a", "b:b", "b:b"]);
});

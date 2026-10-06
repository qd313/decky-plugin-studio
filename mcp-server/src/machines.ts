/**
 * The machine registry: which Deck (or stand-in) a call drives.
 *
 * Until 2026-10-05 this server knew exactly one machine, described by three
 * lines in deck.env (DECK_IP, DECK_USER, DECK_BRIDGE_PORT) and read in about
 * fifty places. Plan 10 (docs/planning/10-stand-in-decks.md) adds stand-in
 * Decks -- Bazzite VMs, and this Windows PC running Steam Big Picture with a
 * Windows build of Decky Loader -- and every one of those fifty readers now
 * has to agree on WHICH machine it is talking about.
 *
 * Three rules, all of them load-bearing:
 *
 *   1. THE MACHINE IS RESOLVED ONCE, AT THE DISPATCH SEAM. index.ts reads the
 *      `machine` argument off a deck_* call, resolves it here, and runs the
 *      tool inside `runWithMachine()`. Everything below the seam asks
 *      `currentMachine()` and never looks at deck.env or a `machine` argument
 *      of its own. Two tools interpreting "which machine" differently is the
 *      bug this rule exists to prevent. The context is an AsyncLocalStorage,
 *      not a module variable, because two tool calls can be in flight at
 *      once on the same stdin and a shared variable would hand one call the
 *      other's machine.
 *
 *   2. `deck` STAYS THE DEFAULT AND STAYS deck.env. bonsAI's existing calls
 *      pass no `machine` and must keep driving the real Deck. The `deck`
 *      entry is derived from deck.env on every read, so deck_configure keeps
 *      working the way it always has; machines.json may add fields to it
 *      (see mergeDeck) but cannot make it vanish.
 *
 *   3. "LOCAL" COMES FROM THE ENTRY, NOT FROM /etc/os-release. The old code
 *      read "this process runs on Bazzite" as "this process runs ON THE
 *      DECK", so a DPS server on a Bazzite host (plan 10, Route B) would have
 *      deployed bonsAI into the host's own Decky folder and skipped every
 *      tunnel. Now `local` is a field. The one concession to the old
 *      behaviour: when the `deck` entry has no host at all and this process
 *      really is on a SteamOS-like machine, remote is impossible, so `local`
 *      defaults to true -- that is the "DPS running on the Deck itself, never
 *      configured an IP" case, and it never misroutes a configured Deck.
 */
import { AsyncLocalStorage } from "async_hooks";
import fs from "fs";
import os from "os";
import path from "path";

import { ensureConfigDir, getConfigDir, readDeckEnv } from "./config.js";

export type MachineKind = "deck" | "standin";
export type MachineOs = "steamos" | "bazzite" | "windows";
/**
 * How a press reaches the machine.
 *   bridge -- the ESP32-S3 board on a serial port (the real Deck's rig).
 *   uinput -- bridge/tools/vpad.py serving an Xbox-class pad on the machine
 *             itself through /dev/uinput, reached over the shared SSH tunnel
 *             (or directly when `local`).
 *   vigem  -- the same vpad.py on a Windows machine, backed by the ViGEmBus
 *             driver, reached on 127.0.0.1 (always `local`).
 *   none   -- reads only; every press refuses with a reason.
 */
export type PressTransport = "bridge" | "uinput" | "vigem" | "none";

export interface Machine {
  name: string;
  kind: MachineKind;
  os: MachineOs;
  /** This process runs on the machine itself: no SSH, no tunnels, local paths. */
  local: boolean;
  /** SSH host (IP or name). Required unless `local`. */
  host?: string;
  /** SSH user. Default "deck". (A non-22 SSH port goes in ~/.ssh/config as a Host alias; see sshTarget.) */
  user?: string;
  press: PressTransport;
  /** `bridge` only: the serial port on THIS PC. Default from DECK_BRIDGE_PORT, else COM7. */
  bridgePort?: string;
  /** `uinput`/`vigem` only: the TCP port vpad.py serves on, on the machine. Default 7690. */
  padPort?: number;
  /** Steam's CEF debugger port on the machine. Default 8080. */
  cdpPort?: number;
  /** Where Decky keeps plugins on the machine. Default ~/homebrew/plugins. */
  pluginsDir?: string;
  /** For a VM: the hypervisor and its name for the VM, so host scripts can find it. */
  vm?: { hypervisor: "virtualbox" | "qemu"; name: string };
  note?: string;
}

/** The part of a machine every result carries, so a stand-in verdict can never be filed as a Deck verdict. */
export interface MachineLabel {
  name: string;
  kind: MachineKind;
  os: MachineOs;
}

export const DEFAULT_MACHINE_NAME = "deck";
export const DEFAULT_PAD_PORT = 7690;
export const DEFAULT_CDP_PORT = 8080;
export const DEFAULT_SSH_USER = "deck";

export interface MachinesFile {
  /** Name used when a call passes no `machine`. Default "deck". */
  default?: string;
  machines?: Record<string, Partial<Omit<Machine, "name">>>;
}

export function getMachinesPath(): string {
  return path.join(getConfigDir(), "machines.json");
}

export class UnknownMachineError extends Error {
  constructor(name: string, known: string[]) {
    super(
      `Unknown machine ${JSON.stringify(name)}. Known machines: ${known.join(", ")}. ` +
        `Add one with deck_configure({ machine: "<name>", kind: "standin", os: "bazzite", host: ..., press: "uinput" }) ` +
        `or edit ${getMachinesPath()}.`,
    );
    this.name = "UnknownMachineError";
  }
}

export class MachinesFileError extends Error {
  constructor(file: string, detail: string) {
    super(`${file} could not be read (${detail}). Fix or remove it; until then only the "deck" machine from deck.env is usable.`);
    this.name = "MachinesFileError";
  }
}

/** Read machines.json. Absent means "no stand-ins"; present-but-broken throws, never silently empties. */
export function readMachinesFile(): MachinesFile {
  const file = getMachinesPath();
  if (!fs.existsSync(file)) return {};
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (err) {
    throw new MachinesFileError(file, (err as Error).message);
  }
  let parsed: unknown;
  try {
    // Notepad and Windows PowerShell 5.1 both write UTF-8 with a byte-order
    // mark, which JSON.parse rejects. A hand-edited registry must still read.
    parsed = JSON.parse(raw.replace(/^﻿/, ""));
  } catch {
    throw new MachinesFileError(file, "not valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new MachinesFileError(file, "top level must be an object");
  }
  const obj = parsed as MachinesFile;
  if (obj.machines != null && (typeof obj.machines !== "object" || Array.isArray(obj.machines))) {
    throw new MachinesFileError(file, '"machines" must be an object keyed by machine name');
  }
  return obj;
}

export function writeMachinesFile(contents: MachinesFile): void {
  ensureConfigDir();
  const file = getMachinesPath();
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(contents, null, 2) + "\n", "utf8");
  fs.renameSync(tmp, file);
}

/**
 * Is THIS PROCESS on a SteamOS-like host? Informational only. It feeds the
 * one default described in the header (an unconfigured `deck` entry on a
 * SteamOS host is local) and deck_getEnv's report. Nothing else may branch
 * on it -- that was the trap.
 */
export function hostIsSteamOsLike(): { steamOsLike: boolean; id: string } {
  if (process.platform === "win32") return { steamOsLike: false, id: "windows" };
  try {
    const release = fs.readFileSync("/etc/os-release", "utf8");
    const id = (release.match(/^ID=(.+)$/m)?.[1] ?? "").replace(/"/g, "");
    const idLike = (release.match(/^ID_LIKE=(.+)$/m)?.[1] ?? "").replace(/"/g, "");
    const steamOsLike =
      id === "steamos" || id === "bazzite" || idLike.includes("steamos") || idLike.includes("fedora");
    return { steamOsLike, id: id || os.platform() };
  } catch {
    return { steamOsLike: false, id: os.platform() };
  }
}

const KINDS: ReadonlySet<string> = new Set<MachineKind>(["deck", "standin"]);
const OSES: ReadonlySet<string> = new Set<MachineOs>(["steamos", "bazzite", "windows"]);
const TRANSPORTS: ReadonlySet<string> = new Set<PressTransport>(["bridge", "uinput", "vigem", "none"]);

/**
 * Validate one entry. Throws with the field named, so a typo in machines.json
 * fails the first call that touches that machine rather than driving the
 * wrong thing. Fields not understood are dropped, not kept, so a result's
 * `machine` label never carries something nobody validated.
 */
export function normalizeMachine(name: string, entry: Partial<Omit<Machine, "name">>): Machine {
  const where = `machine ${JSON.stringify(name)}`;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) {
    throw new Error(`${where}: names are letters, digits, dot, dash and underscore only`);
  }
  const kind = entry.kind ?? (name === DEFAULT_MACHINE_NAME ? "deck" : "standin");
  if (!KINDS.has(kind)) throw new Error(`${where}: kind must be "deck" or "standin", got ${JSON.stringify(kind)}`);
  const osName = entry.os ?? (kind === "deck" ? "steamos" : "bazzite");
  if (!OSES.has(osName)) throw new Error(`${where}: os must be steamos, bazzite or windows, got ${JSON.stringify(osName)}`);
  const press = entry.press ?? (kind === "deck" ? "bridge" : osName === "windows" ? "vigem" : "uinput");
  if (!TRANSPORTS.has(press)) {
    throw new Error(`${where}: press must be bridge, uinput, vigem or none, got ${JSON.stringify(press)}`);
  }
  const local = Boolean(entry.local);
  // A remote machine with no host is merely unconfigured, not invalid: the
  // tools that need SSH say "DECK_IP not configured" at the moment they need
  // it, exactly as before, and everything that does not need SSH keeps working.
  const host = entry.host?.trim() || undefined;
  if (press === "vigem" && !local) {
    throw new Error(`${where}: press "vigem" is a Windows software pad on this PC, so the machine must be local`);
  }
  if (press === "vigem" && osName !== "windows") {
    throw new Error(`${where}: press "vigem" needs os "windows"`);
  }
  if (press === "uinput" && osName === "windows") {
    throw new Error(`${where}: press "uinput" is Linux-only; a Windows machine uses "vigem" or "bridge"`);
  }
  const num = (v: unknown, field: string): number | undefined => {
    if (v == null) return undefined;
    const n = Number(v);
    if (!Number.isInteger(n) || n <= 0 || n > 65535) throw new Error(`${where}: ${field} must be a port number`);
    return n;
  };
  const m: Machine = {
    name,
    kind,
    os: osName,
    local,
    host,
    user: entry.user?.trim() || DEFAULT_SSH_USER,
    press,
    bridgePort: entry.bridgePort?.trim() || undefined,
    padPort: num(entry.padPort, "padPort"),
    cdpPort: num(entry.cdpPort, "cdpPort"),
    pluginsDir: entry.pluginsDir?.trim() || undefined,
    vm: entry.vm,
    note: entry.note,
  };
  if (m.vm) {
    if (m.vm.hypervisor !== "virtualbox" && m.vm.hypervisor !== "qemu") {
      throw new Error(`${where}: vm.hypervisor must be "virtualbox" or "qemu"`);
    }
    if (!m.vm.name) throw new Error(`${where}: vm.name is required when vm is set`);
  }
  // Drop undefined keys so JSON round-trips and deepEqual stay tidy.
  for (const k of Object.keys(m) as (keyof Machine)[]) if (m[k] === undefined) delete m[k];
  return m;
}

/**
 * The `deck` machine: deck.env first, then whatever machines.json adds.
 *
 * deck.env always supplies host/user/bridgePort when it has them, because
 * deck_configure writes there and must keep taking effect. machines.json may
 * add `local`, `cdpPort`, `pluginsDir`, a note. If it names a host too, it
 * loses to deck.env -- one source of truth for the address of the real Deck.
 */
function deckEntry(fileEntry: Partial<Omit<Machine, "name">> | undefined): Machine {
  const env = readDeckEnv();
  const host = env.DECK_IP?.trim() || fileEntry?.host?.trim() || undefined;
  const local = fileEntry?.local ?? (!host && hostIsSteamOsLike().steamOsLike);
  return normalizeMachine(DEFAULT_MACHINE_NAME, {
    kind: "deck",
    os: fileEntry?.os ?? "steamos",
    press: fileEntry?.press ?? "bridge",
    ...fileEntry,
    local,
    host,
    user: env.DECK_USER?.trim() || fileEntry?.user || DEFAULT_SSH_USER,
    bridgePort: env.DECK_BRIDGE_PORT?.trim() || fileEntry?.bridgePort,
  });
}

/** Every machine, `deck` first. Throws on a broken machines.json or a bad entry. */
export function listMachines(): Machine[] {
  const file = readMachinesFile();
  const entries = file.machines ?? {};
  const out: Machine[] = [deckEntry(entries[DEFAULT_MACHINE_NAME])];
  for (const [name, entry] of Object.entries(entries)) {
    if (name === DEFAULT_MACHINE_NAME) continue;
    out.push(normalizeMachine(name, entry ?? {}));
  }
  return out;
}

export function defaultMachineName(): string {
  const d = readMachinesFile().default?.trim();
  return d || DEFAULT_MACHINE_NAME;
}

/** Resolve a name (or the default) to a machine, or throw naming every known one. */
export function resolveMachine(name?: string | null): Machine {
  const wanted = (name ?? "").trim() || defaultMachineName();
  const all = listMachines();
  const found = all.find((m) => m.name === wanted);
  if (!found) throw new UnknownMachineError(wanted, all.map((m) => m.name));
  return found;
}

/**
 * Add or replace a stand-in entry (or extend `deck`), or remove one.
 * Validates before writing, so a bad entry never lands in the file.
 */
export function upsertMachine(
  name: string,
  entry: Partial<Omit<Machine, "name">>,
  opts: { remove?: boolean; makeDefault?: boolean } = {},
): { machine: Machine | null; path: string } {
  const file = readMachinesFile();
  const machines = { ...(file.machines ?? {}) };
  if (opts.remove) {
    if (name === DEFAULT_MACHINE_NAME) throw new Error('the "deck" machine comes from deck.env and cannot be removed');
    delete machines[name];
    const next: MachinesFile = { ...file, machines };
    if (next.default === name) delete next.default;
    writeMachinesFile(next);
    return { machine: null, path: getMachinesPath() };
  }
  const merged = { ...(machines[name] ?? {}), ...entry };
  // Validate the merged entry the way listMachines() will read it back.
  const normalized = name === DEFAULT_MACHINE_NAME ? deckEntryPreview(merged) : normalizeMachine(name, merged);
  machines[name] = merged;
  const next: MachinesFile = { ...file, machines };
  if (opts.makeDefault) next.default = name;
  writeMachinesFile(next);
  return { machine: normalized, path: getMachinesPath() };
}

function deckEntryPreview(entry: Partial<Omit<Machine, "name">>): Machine {
  return deckEntry(entry);
}

export function labelOf(m: Machine): MachineLabel {
  return { name: m.name, kind: m.kind, os: m.os };
}

/**
 * SSH destination for a remote machine. Throws the same "not configured"
 * message the single-Deck code always threw when DECK_IP was missing.
 *
 * A non-standard SSH port (a NAT-forwarded VM on 2222) is NOT a field here:
 * every ssh/scp command in this server spells `user@host`, so the port lives
 * in ~/.ssh/config as a Host alias, which the create-vm script writes. One
 * place, every command honours it, nothing to plumb.
 */
export function sshTarget(m: Machine): { user: string; host: string } {
  if (m.local) throw new Error(`machine "${m.name}" is local; it has no SSH target`);
  if (!m.host) {
    throw new Error(
      m.name === DEFAULT_MACHINE_NAME
        ? "DECK_IP not configured — run deck.configure first"
        : `machine "${m.name}" has no host configured`,
    );
  }
  return { user: m.user ?? DEFAULT_SSH_USER, host: m.host };
}

// ---------------------------------------------------------------------------
// The per-call context
// ---------------------------------------------------------------------------

const als = new AsyncLocalStorage<Machine>();

/** Run `fn` with `machine` as the current machine for everything it awaits. */
export function runWithMachine<T>(machine: Machine, fn: () => Promise<T> | T): Promise<T> {
  return als.run(machine, async () => fn());
}

/**
 * The machine the current call drives. Outside any call (a test calling a
 * tool function directly, the extension's dialect before the seam existed)
 * this is the default machine, resolved fresh -- which is exactly the old
 * single-Deck behaviour.
 */
export function currentMachine(): Machine {
  return als.getStore() ?? resolveMachine();
}

/** The current machine if one was set by the seam, else null. For callers that must not resolve. */
export function currentMachineIfAny(): Machine | null {
  return als.getStore() ?? null;
}

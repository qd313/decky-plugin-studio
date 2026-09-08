/**
 * deck_snapshotSettings / deck_restoreSettings.
 *
 * Every device session currently ends with someone putting the Deck back by
 * hand: settings, pinned test questions, which tab was open -- there is a
 * `settings.json.bak-preQA` sitting on a Deck right now because nothing
 * tooled does this. This copies the plugin's settings directory (and,
 * optionally, its data directory) off the Deck into a local run file before a
 * test round touches anything, and puts exactly that copy back afterwards.
 *
 * Built on the same shared snapshot/lease machinery as deck_holdAwake (see
 * ./snapshotLease.ts) for the refuse-stale, expire-towards-safe and
 * corrupt-detection rules. The one difference from deck_holdAwake: this
 * "take" step never changes anything on the Deck by itself (there is no
 * "disabled" state to push at snapshot time) -- it only captures. The change
 * a test round makes happens through the plugin's own UI, not through this
 * tool; deck_restoreSettings is what undoes it.
 *
 * UNVERIFIED ON HARDWARE. This assumes the real, well-documented Decky Loader
 * convention -- `~/homebrew/settings/<plugin name>` and
 * `~/homebrew/data/<plugin name>` -- but nothing here has been run against a
 * real Deck. See this lane's report for the honest limits.
 */
import crypto from "crypto";
import fs from "fs";
import path from "path";

import { getConfigDir, readDeckEnv } from "../config.js";
import { proc, quoteRemotePath } from "../deploy/deployHelpers.js";
import { detectPlugin, remotePluginDirName } from "../tools/plugin.js";
import {
  RestoreReport,
  SnapshotController,
  TakeReport,
  restoreSnapshot,
  takeSnapshot,
} from "./snapshotLease.js";

export interface SettingsSnapshotValues {
  pluginName: string;
  remoteSettingsDir: string;
  remoteDataDir: string | null;
  /** Local file holding the tar archive of both directories, base64-decoded. */
  archivePath: string;
  sha256: string;
  sizeBytes: number;
}

const SETTINGS_KIND = "settings-hold";
export const RESTORE_SETTINGS_TOOL_HINT = "deck_restoreSettings";
const DEFAULT_TTL_MINUTES = 30;

/** Both settings and data live directly under here, so one `-C` root lets a
 * single tar call pack (or unpack) both without their identical basenames
 * colliding -- the archive entries come out as `settings/<name>/...` and
 * `data/<name>/...`, not two directories both named `<name>`. */
const HOMEBREW_ROOT = "~/homebrew";

function remoteSettingsRelPath(name: string): string {
  return `settings/${name}`;
}
function remoteDataRelPath(name: string): string {
  return `data/${name}`;
}

function archiveDir(): string {
  return path.join(getConfigDir(), "snapshots", "settings-archives");
}

function shellCmd(): string {
  return process.platform === "win32" ? "cmd.exe" : "/bin/sh";
}

function connectedEnv(): { user: string; host: string } {
  const env = readDeckEnv();
  const host = env.DECK_IP;
  if (!host) throw new Error("DECK_IP not configured — run deck_configure first");
  return { user: env.DECK_USER ?? "deck", host };
}

function pluginNameForSnapshot(): string {
  const info = detectPlugin();
  if (!info.valid) {
    throw new Error(info.reason ?? "Invalid plugin workspace — run from a Decky plugin directory");
  }
  // Reuses the same shell-safety check the remote deploy already applies to
  // this same field: it is interpolated into a remote command below, and
  // detectPlugin() validates nothing about plugin.json's `name`.
  return remotePluginDirName(info.name);
}

/**
 * Pull the settings dir (and, when requested, the data dir) as one
 * base64-encoded tar stream in a single ssh round trip.
 *
 * Base64, not raw bytes: proc.execSync's contract here is "returns a string",
 * and a raw tar stream captured as a string would corrupt at the first byte
 * that is not valid in whatever text encoding the child's stdout is decoded
 * with. Going through base64 for this exact reason is the same trick several
 * CI artifact transports use for a single-string round trip.
 */
export function pullSettingsCommand(user: string, host: string, name: string, includeData: boolean): string {
  const rels = [remoteSettingsRelPath(name)];
  if (includeData) rels.push(remoteDataRelPath(name));
  const quotedRels = rels.map((r) => quoteRemotePath(r)).join(" ");
  const remote = `tar cf - -C ${quoteRemotePath(HOMEBREW_ROOT)} ${quotedRels} 2>/dev/null | base64 -w0`;
  return `ssh -o BatchMode=yes -o ConnectTimeout=8 ${user}@${host} "${remote}"`;
}

/** Strips the `~/homebrew/` prefix, leaving e.g. `settings/bonsAI`. Falls back
 * to the full path if it somehow does not have that prefix -- defensive only,
 * since every caller builds these from HOMEBREW_ROOT itself. */
function relToHomebrew(fullPath: string): string {
  const prefix = `${HOMEBREW_ROOT}/`;
  return fullPath.startsWith(prefix) ? fullPath.slice(prefix.length) : fullPath;
}

/** Fixed, precomputed staging path -- same idea as deployHelpers'
 * remoteDeployTempDir(), and for the same reason: a `$(mktemp -d)` or a bare
 * `$T` inside this string would be evaluated by a LOCAL POSIX shell too (this
 * whole string is one argument to a double-quoted `ssh ... "..."` call), not
 * only the remote one, exactly the hazard moveDeployedPluginIntoPlace's
 * comment warns about for `$(dirname ...)`. A literal path computed here in
 * JS has no such ambiguity. */
function remoteStageDir(): string {
  return `/tmp/decky-studio-settings-restore-${Date.now()}`;
}

/**
 * Reads the base64 tar stream from stdin, extracts it into a fresh staging
 * directory, and only once that succeeds replaces `remoteDirs` with what was
 * staged.
 *
 * STAGE THEN SWAP, not extract-over-the-top. A plain `tar xf -` onto the live
 * directories only overwrites files present in the archive -- anything a test
 * round added since the snapshot (a new pinned chip's key, a new settings
 * field) would survive, which is the opposite of "byte-identical to the
 * snapshot". Removing the live directories first and extracting straight
 * into their place is the other obvious approach, and is worse: a failed or
 * truncated transfer would then leave the Deck with no settings directory at
 * all instead of its original one. Staging first means a bad archive fails
 * before a single real directory is touched.
 *
 * `remoteDirs` are the exact paths recorded in the snapshot's own run file
 * (not recomputed here), so this only ever replaces what was actually
 * captured -- when includeData was false at snapshot time, the data
 * directory is absent from `remoteDirs` and is left alone.
 */
export function pushSettingsCommand(user: string, host: string, remoteDirs: string[], stageDir: string): string {
  const moves = remoteDirs
    .map(
      (full) =>
        `rm -rf ${quoteRemotePath(full)} && mv ${quoteRemotePath(`${stageDir}/${relToHomebrew(full)}`)} ${quoteRemotePath(full)}`
    )
    .join(" && ");
  const remote =
    `mkdir -p ${quoteRemotePath(stageDir)} && base64 -d | tar xf - -C ${quoteRemotePath(stageDir)} && ` +
    `${moves} && rm -rf ${quoteRemotePath(stageDir)}`;
  return `ssh -o BatchMode=yes -o ConnectTimeout=8 ${user}@${host} "${remote}"`;
}

function readCurrentSettings(includeData: boolean): SettingsSnapshotValues {
  const { user, host } = connectedEnv();
  const name = pluginNameForSnapshot();
  const remoteSettingsDir = `${HOMEBREW_ROOT}/${remoteSettingsRelPath(name)}`;
  const remoteDataDir = includeData ? `${HOMEBREW_ROOT}/${remoteDataRelPath(name)}` : null;

  const out = String(
    proc.execSync(pullSettingsCommand(user, host, name, includeData), {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 64 * 1024 * 1024,
      shell: shellCmd(),
    }) ?? ""
  );
  const b64 = out.trim();
  if (!b64) {
    throw new Error(
      `No data came back pulling ${remoteSettingsDir}` +
        (remoteDataDir ? ` and ${remoteDataDir}` : "") +
        " from the Deck -- does the settings directory exist yet? " +
        "(Decky Loader creates it the first time the plugin's backend runs.)"
    );
  }

  const buf = Buffer.from(b64, "base64");
  const sha256 = crypto.createHash("sha256").update(buf).digest("hex");

  fs.mkdirSync(archiveDir(), { recursive: true });
  const archivePath = path.join(archiveDir(), `${SETTINGS_KIND}-${Date.now()}-${process.pid}.tar`);
  fs.writeFileSync(archivePath, buf);

  return { pluginName: name, remoteSettingsDir, remoteDataDir, archivePath, sha256, sizeBytes: buf.length };
}

/**
 * Push a previously-captured archive back onto the Deck.
 *
 * Verifies the archive's checksum against what was recorded at snapshot time
 * BEFORE anything is sent over ssh: a truncated or hand-edited archive file
 * must be refused here rather than pushed and only discovered wrong on the
 * device.
 */
function applySettings(values: SettingsSnapshotValues): void {
  const { user, host } = connectedEnv();

  let buf: Buffer;
  try {
    buf = fs.readFileSync(values.archivePath);
  } catch (err) {
    throw new Error(
      `Cannot restore settings: the archive at ${values.archivePath} recorded in the snapshot ` +
        `is missing or unreadable (${(err as Error).message}). Nothing was sent to the Deck.`
    );
  }

  const sha256 = crypto.createHash("sha256").update(buf).digest("hex");
  if (sha256 !== values.sha256) {
    throw new Error(
      `Cannot restore settings: the archive at ${values.archivePath} does not match the ` +
        `checksum recorded when it was taken (expected ${values.sha256}, got ${sha256}). It may ` +
        "be truncated or was overwritten -- refusing to push an unverified copy. Inspect the " +
        "file by hand before retrying."
    );
  }

  const remoteDirs = [values.remoteSettingsDir, ...(values.remoteDataDir ? [values.remoteDataDir] : [])];
  proc.execSync(pushSettingsCommand(user, host, remoteDirs, remoteStageDir()), {
    input: buf.toString("base64"),
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
    shell: shellCmd(),
  });

  // Best-effort cleanup: the run file is cleared by the caller right after
  // this, and leaving stale tarballs behind is exactly the kind of manual
  // tidy-up this tool exists to remove.
  try {
    fs.rmSync(values.archivePath, { force: true });
  } catch {
    /* not worth failing a successful restore over */
  }
}

function controller(ttlMinutes: number): SnapshotController<SettingsSnapshotValues> {
  return {
    kind: SETTINGS_KIND,
    restoreToolHint: RESTORE_SETTINGS_TOOL_HINT,
    ttlMinutes,
    readCurrent: () => readCurrentSettings(false),
    apply: applySettings,
  };
}

export interface SnapshotSettingsOptions {
  includeData?: boolean;
  ttlMinutes?: number;
  note?: string;
  /** Test-only clock override; production always uses Date.now. */
  now?: () => number;
}

export type SnapshotSettingsResult = TakeReport<SettingsSnapshotValues> & { summary: string };

export async function snapshotSettings(opts: SnapshotSettingsOptions = {}): Promise<SnapshotSettingsResult> {
  const ttlMinutes = opts.ttlMinutes ?? DEFAULT_TTL_MINUTES;
  const includeData = Boolean(opts.includeData);
  const ctrl: SnapshotController<SettingsSnapshotValues> = {
    kind: SETTINGS_KIND,
    restoreToolHint: RESTORE_SETTINGS_TOOL_HINT,
    ttlMinutes,
    readCurrent: () => readCurrentSettings(includeData),
    apply: applySettings,
  };

  // No `applyNew`: taking a settings snapshot never changes the Deck by
  // itself, unlike deck_holdAwake -- it only captures. See the module header.
  const report = await takeSnapshot(ctrl, undefined, { note: opts.note, now: opts.now });

  const summary =
    `copied ${report.previous.remoteSettingsDir}` +
    (report.previous.remoteDataDir ? ` and ${report.previous.remoteDataDir}` : "") +
    ` (${report.previous.sizeBytes} bytes) to ${report.path}. Call ${RESTORE_SETTINGS_TOOL_HINT} ` +
    `to put it back -- it also restores itself automatically at ${report.expiresAt} if nothing ` +
    "calls it first." +
    (report.autoRestoredExpired
      ? ` Note: an earlier snapshot from ${report.autoRestoredExpired.at} had expired and was ` +
        "restored first."
      : "");

  return { ...report, summary };
}

export type RestoreSettingsResult = RestoreReport<SettingsSnapshotValues> & { summary: string };

export async function restoreSettings(): Promise<RestoreSettingsResult> {
  const report = await restoreSnapshot(controller(DEFAULT_TTL_MINUTES));
  return { ...report, summary: report.note };
}

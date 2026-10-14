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
 * TWO WAYS TO COPY, BECAUSE THE FOLDER CAN BE BIG. The plugin's settings folder
 * holds saved chats and can pass 70 MB. The first way is one buffered ssh call
 * (the tar comes back as base64 text in memory); it is kept for small folders.
 * It died with `spawnSync cmd.exe ENOBUFS` on 2026-10-11 because base64 inflates
 * the tar by a third and the call's buffer was a fixed size. So an overflow now
 * falls back to the second way: ssh is started with spawn (no shell, no buffer)
 * and its stdout goes straight into the archive file; restore streams that file
 * back the same way. The result says which way was used (`method`).
 *
 * A STREAMED COPY IS CHECKED, NOT TRUSTED (plan 93). On 2026-10-12 the third of three
 * snapshots said "streamed", ssh exited 0, and the file was 102,400 bytes short and could not
 * be restored. The Deck now counts and hashes what it sends in the same pass; the PC compares
 * that with what arrived and refuses a mismatch (one automatic second try, then an error that
 * names both sizes). The small buffered copy has no such check yet.
 *
 * UNVERIFIED ON HARDWARE. This assumes the real, well-documented Decky Loader
 * convention -- `~/homebrew/settings/<plugin name>` and
 * `~/homebrew/data/<plugin name>` -- but nothing here has been run against a
 * real Deck. See this lane's report for the honest limits.
 */
import { ChildProcess, spawn } from "child_process";
import crypto from "crypto";
import fs from "fs";
import path from "path";

import { getConfigDir } from "../config.js";
import { currentMachine } from "../machines.js";
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
  /** How the archive was copied off the Deck. Absent in run files written
   * before the streamed copy existed; those were always buffered. */
  method?: SnapshotMethod;
  /** One plain line saying why that way was used. */
  methodNote?: string;
}

export type SnapshotMethod = "buffered" | "streamed";

/** What the buffered copy may hold in memory (base64 text, so ~12 MB of tar).
 * Anything bigger overflows and falls back to the streamed copy. Kept small so
 * a big folder wastes little time before the fallback. */
export const BUFFERED_LIMIT_BYTES = 16 * 1024 * 1024;

/** Seam over starting ssh for the streamed copy; tests swap `launch` for a
 * stand-in process. No shell is involved, so there is no quoting layer and no
 * output buffer between ssh and the file. */
export const streamProc = {
  launch(args: string[]): ChildProcess {
    return spawn("ssh", args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  },
};

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
  const m = currentMachine();
  if (m.local) {
    throw new Error(`deck_snapshotSettings copies a plugin's settings off a Deck over SSH; machine "${m.name}" is local`);
  }
  if (!m.host) throw new Error("DECK_IP not configured — run deck_configure first");
  return { user: m.user ?? "deck", host: m.host };
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
  const remote = `${tarOutScript(name, includeData)} 2>/dev/null | base64 -w0`;
  return `ssh -o BatchMode=yes -o ConnectTimeout=8 ${user}@${host} "${remote}"`;
}

function tarOutScript(name: string, includeData: boolean): string {
  const rels = [remoteSettingsRelPath(name)];
  if (includeData) rels.push(remoteDataRelPath(name));
  const quotedRels = rels.map((r) => quoteRemotePath(r)).join(" ");
  return `tar cf - -C ${quoteRemotePath(HOMEBREW_ROOT)} ${quotedRels}`;
}

/** The line the Deck prints (on stderr) for what its own side sent. */
const TRAILER_RE = /DECKSUM size=(\d+) sha=([0-9a-f]{64})/;

/**
 * The remote half of the streamed copy: the tar goes to stdout exactly as
 * before, and in the same pass the Deck counts it (`wc -c`) and hashes it
 * (`sha256sum`) and prints `DECKSUM size=<n> sha=<hex>` on stderr. The PC then
 * compares that with what actually arrived, so a copy that came back short or
 * damaged is caught instead of being called "streamed" (plan 92: 102,400 bytes
 * short, ssh exit 0, no error).
 *
 * Plain POSIX sh (two named pipes and `tee`), because this string goes to the
 * Deck's login shell with no local shell in between. tar exit 1 ("a file changed
 * while it was read") still counts as a whole archive; exit 2 and up fails.
 */
export function verifiedTarOutScript(name: string, includeData: boolean): string {
  return (
    'D=$(mktemp -d) && mkfifo "$D/a" "$D/b" && { ' +
    'sha256sum < "$D/a" > "$D/sha" & wc -c < "$D/b" > "$D/n" & ' +
    `{ ${tarOutScript(name, includeData)} 2>/dev/null; echo $? > "$D/rc"; } | tee "$D/a" "$D/b"; wait; ` +
    'echo "DECKSUM size=$(tr -dc 0-9 < "$D/n") sha=$(cut -d" " -f1 < "$D/sha")" >&2; ' +
    'R=$(cat "$D/rc"); rm -rf "$D"; [ "$R" -le 1 ]; }'
  );
}

/** ssh arguments for the streamed copy (spawned without a shell). The keep-alive
 * options end a copy over a dead link instead of hanging forever. */
function streamSshArgs(user: string, host: string, remote: string): string[] {
  return [
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=8",
    "-o", "ServerAliveInterval=15",
    "-o", "ServerAliveCountMax=4",
    `${user}@${host}`,
    remote,
  ];
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
  return `ssh -o BatchMode=yes -o ConnectTimeout=8 ${user}@${host} "${pushRemoteScript(remoteDirs, stageDir, true)}"`;
}

/** The remote half of a restore. `base64` is true for the buffered way (the
 * archive arrives as text), false for the streamed way (raw tar bytes). */
function pushRemoteScript(remoteDirs: string[], stageDir: string, base64: boolean): string {
  const moves = remoteDirs
    .map(
      (full) =>
        `rm -rf ${quoteRemotePath(full)} && mv ${quoteRemotePath(`${stageDir}/${relToHomebrew(full)}`)} ${quoteRemotePath(full)}`
    )
    .join(" && ");
  const decode = base64 ? "base64 -d | " : "";
  return (
    `mkdir -p ${quoteRemotePath(stageDir)} && ${decode}tar xf - -C ${quoteRemotePath(stageDir)} && ` +
    `${moves} && rm -rf ${quoteRemotePath(stageDir)}`
  );
}

/** True when node's own output-size limit stopped the buffered copy. */
function isBufferOverflow(err: unknown): boolean {
  const e = err as { code?: unknown; message?: unknown };
  return e?.code === "ENOBUFS" || /ENOBUFS|maxBuffer/i.test(String(e?.message ?? ""));
}

function newArchivePath(): string {
  fs.mkdirSync(archiveDir(), { recursive: true });
  return path.join(archiveDir(), `${SETTINGS_KIND}-${Date.now()}-${process.pid}.tar`);
}

/** The copy that arrived is not the copy the Deck sent. */
export class IncompleteCopyError extends Error {
  constructor(
    message: string,
    readonly deckBytes: number | null,
    readonly arrivedBytes: number
  ) {
    super(message);
    this.name = "IncompleteCopyError";
  }
}

/** Runs ssh and writes its stdout straight to `destFile`, hashing as it goes.
 * Nothing is held in memory and no shell sits in between, so the size of the
 * folder cannot overflow anything. A copy that does not finish cleanly leaves
 * no file behind. When it does finish, the size and checksum the Deck printed
 * for its own side (`verifiedTarOutScript`) must equal what arrived; otherwise
 * the copy is thrown away and an IncompleteCopyError names both sizes. */
async function streamArchiveToFile(args: string[], destFile: string): Promise<{ sizeBytes: number; sha256: string }> {
  const partFile = `${destFile}.part`;
  const child = streamProc.launch(args);
  const out = fs.createWriteStream(partFile);
  const hash = crypto.createHash("sha256");
  let sizeBytes = 0;
  let stderr = "";
  child.stderr?.on("data", (c: Buffer) => {
    if (stderr.length < 20000) stderr += c.toString("utf8");
  });
  child.stdout?.on("data", (c: Buffer) => {
    hash.update(c);
    sizeBytes += c.length;
  });
  child.stdin?.on("error", () => {});
  child.stdin?.end();
  child.stdout?.pipe(out);

  try {
    const finished = new Promise<void>((resolve, reject) => {
      out.once("finish", resolve);
      out.once("error", reject);
    });
    const exited = new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => resolve(code));
    });
    const [code] = await Promise.all([exited, finished]);
    if (code !== 0) {
      throw new Error(
        `The streamed copy off the Deck failed: ssh exited with code ${code}` +
          (stderr.trim() ? ` (${stderr.trim().slice(0, 300)})` : "") +
          ". Nothing was saved."
      );
    }
    if (sizeBytes === 0) {
      throw new Error("No data came back in the streamed copy -- does the settings directory exist yet?");
    }
    const sha256 = hash.digest("hex");
    const trailer = TRAILER_RE.exec(stderr);
    if (!trailer) {
      throw new IncompleteCopyError(
        `The streamed copy could not be checked: the Deck did not report the size and checksum of what it sent, ` +
          `so the ${sizeBytes} bytes that arrived cannot be trusted. Nothing was saved.`,
        null,
        sizeBytes
      );
    }
    const deckBytes = Number(trailer[1]);
    if (deckBytes !== sizeBytes) {
      throw new IncompleteCopyError(
        `The streamed copy is not whole: the Deck sent ${deckBytes} bytes but ${sizeBytes} arrived on this PC ` +
          `(${deckBytes - sizeBytes} bytes ${deckBytes > sizeBytes ? "short" : "too many"}). Nothing was saved.`,
        deckBytes,
        sizeBytes
      );
    }
    if (trailer[2] !== sha256) {
      throw new IncompleteCopyError(
        `The streamed copy is damaged: it is ${sizeBytes} bytes on both sides, but the checksum on the Deck ` +
          `(${trailer[2]}) differs from the one on this PC (${sha256}). Nothing was saved.`,
        deckBytes,
        sizeBytes
      );
    }
    fs.renameSync(partFile, destFile);
    return { sizeBytes, sha256 };
  } catch (err) {
    out.destroy();
    fs.rmSync(partFile, { force: true });
    throw err;
  }
}

/** One streamed copy, taken again once if it does not match the Deck's own word.
 * Anything else (ssh down, no data) is not retried. */
async function streamVerifiedCopy(
  user: string,
  host: string,
  name: string,
  includeData: boolean
): Promise<{ archivePath: string; sizeBytes: number; sha256: string; attempts: number }> {
  const args = streamSshArgs(user, host, verifiedTarOutScript(name, includeData));
  const failures: IncompleteCopyError[] = [];
  for (let attempt = 1; attempt <= 2; attempt++) {
    const archivePath = newArchivePath();
    try {
      const { sizeBytes, sha256 } = await streamArchiveToFile(args, archivePath);
      return { archivePath, sizeBytes, sha256, attempts: attempt };
    } catch (err) {
      if (!(err instanceof IncompleteCopyError)) throw err;
      failures.push(err);
    }
  }
  throw new Error(
    "The streamed copy of the settings folder did not match the Deck's own size and checksum on either of two " +
      "tries, so nothing was saved. First try: " +
      failures[0].message.replace(/ Nothing was saved\.$/, "") +
      " Second try: " +
      failures[1].message.replace(/ Nothing was saved\.$/, "")
  );
}

/** Streams `srcFile` into ssh's stdin (raw bytes, no shell) and waits for the
 * remote command to finish. A non-zero exit throws, naming what ssh said. */
async function streamFileToSsh(args: string[], srcFile: string): Promise<void> {
  const child = streamProc.launch(args);
  let stderr = "";
  child.stderr?.on("data", (c: Buffer) => {
    if (stderr.length < 2000) stderr += c.toString("utf8");
  });
  child.stdout?.resume();
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code));
  });
  const input = fs.createReadStream(srcFile);
  // A remote that quits early closes the pipe; the exit code below says why.
  child.stdin?.on("error", () => {});
  input.on("error", () => child.kill());
  input.pipe(child.stdin!);
  const code = await exited;
  if (code !== 0) {
    throw new Error(
      `The streamed restore to the Deck failed: ssh exited with code ${code}` +
        (stderr.trim() ? ` (${stderr.trim().slice(0, 300)})` : "") +
        ". The saved copy was kept."
    );
  }
}

function hashFile(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash("sha256");
    fs.createReadStream(file)
      .on("data", (c) => h.update(c))
      .on("error", reject)
      .on("end", () => resolve(h.digest("hex")));
  });
}

async function readCurrentSettings(includeData: boolean): Promise<SettingsSnapshotValues> {
  const { user, host } = connectedEnv();
  const name = pluginNameForSnapshot();
  const remoteSettingsDir = `${HOMEBREW_ROOT}/${remoteSettingsRelPath(name)}`;
  const remoteDataDir = includeData ? `${HOMEBREW_ROOT}/${remoteDataRelPath(name)}` : null;

  let out: string;
  try {
    out = String(
      proc.execSync(pullSettingsCommand(user, host, name, includeData), {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        maxBuffer: BUFFERED_LIMIT_BYTES,
        shell: shellCmd(),
      }) ?? ""
    );
  } catch (err) {
    if (!isBufferOverflow(err)) throw err;
    // Too big to hold as one piece (this is the 2026-10-11 ENOBUFS). Copy it
    // again, streaming straight to a file and checking it against the Deck's
    // own size and checksum. tar exit 1 only means a file changed while it was
    // being read; the archive is still whole.
    const { archivePath, sizeBytes, sha256, attempts } = await streamVerifiedCopy(user, host, name, includeData);
    return {
      pluginName: name,
      remoteSettingsDir,
      remoteDataDir,
      archivePath,
      sha256,
      sizeBytes,
      method: "streamed",
      methodNote:
        "the folder was too big for the one-piece copy (it hit the buffer limit, ENOBUFS), so it was " +
        "streamed straight to a file instead; the size and checksum match what the Deck reported for its own side" +
        (attempts > 1 ? " (the first copy came back short or damaged, so it was taken again)" : ""),
    };
  }
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

  const archivePath = newArchivePath();
  fs.writeFileSync(archivePath, buf);

  return {
    pluginName: name,
    remoteSettingsDir,
    remoteDataDir,
    archivePath,
    sha256,
    sizeBytes: buf.length,
    method: "buffered",
    methodNote: "the folder was small enough to copy in one piece over ssh",
  };
}

/**
 * Push a previously-captured archive back onto the Deck.
 *
 * Verifies the archive's checksum against what was recorded at snapshot time
 * BEFORE anything is sent over ssh: a truncated or hand-edited archive file
 * must be refused here rather than pushed and only discovered wrong on the
 * device. A streamed snapshot is read from disk as a stream (it may be far too
 * big to hold in memory) and sent as raw tar; a buffered one (or an older run
 * file with no method) goes the original base64 way.
 */
async function applySettings(values: SettingsSnapshotValues): Promise<void> {
  const { user, host } = connectedEnv();
  const streamed = values.method === "streamed";
  const remoteDirs = [values.remoteSettingsDir, ...(values.remoteDataDir ? [values.remoteDataDir] : [])];

  const mismatch = (got: string): Error =>
    new Error(
      `Cannot restore settings: the archive at ${values.archivePath} does not match the ` +
        `checksum recorded when it was taken (expected ${values.sha256}, got ${got}). It may ` +
        "be truncated or was overwritten -- refusing to push an unverified copy. Inspect the " +
        "file by hand before retrying."
    );
  const missing = (err: unknown): Error =>
    new Error(
      `Cannot restore settings: the archive at ${values.archivePath} recorded in the snapshot ` +
        `is missing or unreadable (${(err as Error).message}). Nothing was sent to the Deck.`
    );

  if (streamed) {
    let sha256: string;
    try {
      sha256 = await hashFile(values.archivePath);
    } catch (err) {
      throw missing(err);
    }
    if (sha256 !== values.sha256) throw mismatch(sha256);
    await streamFileToSsh(
      streamSshArgs(user, host, pushRemoteScript(remoteDirs, remoteStageDir(), false)),
      values.archivePath
    );
  } else {
    let buf: Buffer;
    try {
      buf = fs.readFileSync(values.archivePath);
    } catch (err) {
      throw missing(err);
    }
    const sha256 = crypto.createHash("sha256").update(buf).digest("hex");
    if (sha256 !== values.sha256) throw mismatch(sha256);
    proc.execSync(pushSettingsCommand(user, host, remoteDirs, remoteStageDir()), {
      input: buf.toString("base64"),
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      maxBuffer: BUFFERED_LIMIT_BYTES,
      shell: shellCmd(),
    });
  }

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

export type SnapshotSettingsResult = TakeReport<SettingsSnapshotValues> & {
  summary: string;
  /** How the copy was made: "buffered" (one piece, small folders) or "streamed"
   * (straight to a file, big folders). */
  method: SnapshotMethod;
  /** One plain line saying why. */
  methodNote: string;
};

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

  const method: SnapshotMethod = report.previous.method ?? "buffered";
  const methodNote = report.previous.methodNote ?? "copied in one piece over ssh";
  const summary =
    `copied ${report.previous.remoteSettingsDir}` +
    (report.previous.remoteDataDir ? ` and ${report.previous.remoteDataDir}` : "") +
    ` (${report.previous.sizeBytes} bytes, ${method}: ${methodNote}) to ${report.path}. Call ${RESTORE_SETTINGS_TOOL_HINT} ` +
    `to put it back -- it also restores itself automatically at ${report.expiresAt} if nothing ` +
    "calls it first." +
    (report.autoRestoredExpired
      ? ` Note: an earlier snapshot from ${report.autoRestoredExpired.at} had expired and was ` +
        "restored first."
      : "");

  return { ...report, summary, method, methodNote };
}

export type RestoreSettingsResult = RestoreReport<SettingsSnapshotValues> & { summary: string };

export async function restoreSettings(): Promise<RestoreSettingsResult> {
  const report = await restoreSnapshot(controller(DEFAULT_TTL_MINUTES));
  return { ...report, summary: report.note };
}

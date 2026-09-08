/**
 * The cheap half of "is the Deck ready": is the exact build we would ship the
 * one already installed on the Deck?
 *
 * `deck_deploy` already knows precisely which top-level entries it copies
 * (`listDeploySources`, in ../deploy/copyManifest.ts) and where they land
 * (`~/homebrew/plugins/<name>`). This hashes those SAME entries on both sides
 * -- every file's own sha256, combined in one fixed order -- and compares the
 * two combined hashes. It is strictly less than a plugin's own `build.ps1
 * md5sum` loop, because it is exactly the manifest deploy already has, read
 * twice instead of trusted once.
 *
 * NOT a general directory diff. Only the entries a deploy actually copies are
 * hashed, so a remote `data/` directory a plugin seeds separately (which
 * deployHelpers.ts's moveDeployedPluginIntoPlace deliberately never touches)
 * is correctly invisible here -- the same thing a deploy itself does.
 */
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { listDeploySources } from "../deploy/copyManifest.js";
import { proc, quoteRemotePath } from "../deploy/deployHelpers.js";

export interface ManifestEntry {
  /** Forward-slash path, relative to the plugin root (local) or the deploy target (remote). */
  path: string;
  sha256: string;
}

function shell(): string {
  return process.platform === "win32" ? "cmd.exe" : "/bin/sh";
}

function toPosix(rel: string): string {
  return rel.split(path.sep).join("/");
}

/** Every file under one deploy-source entry, relative to pluginRoot. */
function listFiles(pluginRoot: string, rel: string): string[] {
  const abs = path.join(pluginRoot, rel);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(abs);
  } catch {
    // An entry that vanished between listDeploySources() and here -- skip it
    // rather than crash. checks/buildHash.ts fingerprints through this
    // function from two unguarded call sites in checkRunner, and a mid-build
    // race is not worth an exception there. A tree that is unreadable in its
    // entirety still fails safe: an empty manifest, which verifyDeployedBuild
    // reports as `matches: null`, never as a match.
    return [];
  }
  if (!stat.isDirectory()) return [toPosix(rel)];
  const out: string[] = [];
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    const childRel = path.join(rel, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(pluginRoot, childRel));
    else out.push(toPosix(childRel));
  }
  return out;
}

function sortEntries(entries: ManifestEntry[]): ManifestEntry[] {
  return [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/**
 * Every file the deploy would copy for this plugin, each hashed on its own
 * content, sorted into a stable order. Throws when `pluginRoot` itself cannot
 * be read -- the caller decides what an unreadable local tree means (never a
 * silent match).
 */
export function localBuildManifest(pluginRoot: string): ManifestEntry[] {
  const sources = listDeploySources(pluginRoot);
  const files = sources.flatMap((rel) => listFiles(pluginRoot, rel));
  const entries = files.map((rel) => ({
    path: rel,
    sha256: crypto
      .createHash("sha256")
      .update(fs.readFileSync(path.join(pluginRoot, ...rel.split("/"))))
      .digest("hex"),
  }));
  return sortEntries(entries);
}

/**
 * One hash standing for a whole manifest -- the thing actually compared.
 * Shared by both sides so the algorithm is identical whichever produced the
 * per-file entries: this function never touches a filesystem or a network.
 */
export function combineManifest(entries: ManifestEntry[]): string {
  const h = crypto.createHash("sha256");
  for (const e of sortEntries(entries)) h.update(`${e.path}:${e.sha256}\n`);
  return h.digest("hex");
}

export function localBuildHash(pluginRoot: string): string {
  return combineManifest(localBuildManifest(pluginRoot));
}

/**
 * The remote command that hashes the same entries on the Deck, inside the
 * deployed plugin's own directory. `find ... -exec sha256sum {} +` rather than
 * a shell loop, so it runs with whatever POSIX userland SteamOS ships.
 *
 * Known limit, stated rather than hidden: a filename containing a space or a
 * newline would not round-trip through `sha256sum`'s output format correctly.
 * None of `DEPLOY_COPY_ENTRIES` is a candidate for that, and it is the same
 * limit deployHelpers.ts's own scp loop already lives with.
 */
export function remoteHashCommand(user: string, host: string, targetDir: string, entries: string[]): string {
  // These entries come from DEPLOY_COPY_ENTRIES (a fixed, safe vocabulary) plus
  // root-level *.py filenames off the plugin's own disk -- escaped defensively
  // rather than trusted, since the second half is not a fixed list.
  const list = entries.map((e) => e.replace(/(["\\$`])/g, "\\$1")).join(" ");
  const remote = `cd ${quoteRemotePath(targetDir)} 2>/dev/null && find ${list} -type f -exec sha256sum {} + 2>/dev/null`;
  return `ssh -o BatchMode=yes -o ConnectTimeout=8 ${user}@${host} "${remote}"`;
}

/** Parses `sha256sum` output into the same shape `localBuildManifest` produces. */
export function parseHashOutput(output: string): ManifestEntry[] {
  const out: ManifestEntry[] = [];
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const m = /^([0-9a-f]{64})\s+\*?(.+)$/.exec(line);
    if (!m) continue;
    let p = m[2].trim();
    if (p.startsWith("./")) p = p.slice(2);
    out.push({ path: p, sha256: m[1] });
  }
  return sortEntries(out);
}

export interface BuildHashResult {
  /** null only when it could not be evaluated at all -- see `reason`. */
  matches: boolean | null;
  localHash: string | null;
  remoteHash: string | null;
  localCount: number;
  remoteCount: number;
  reason?: string;
}

const MISSING_DIR = /no such file or directory/i;

/**
 * Compares the local build's hash to what is actually deployed on the Deck.
 * Never throws: an unreadable local tree, or an SSH failure, comes back as
 * `matches: null` with `reason` saying which -- an unknown must never read as
 * a match. A definitively-absent deploy target (the directory does not exist
 * on the Deck at all) is reported as a confident `matches: false` instead,
 * since "never deployed" is a finding, not a mystery.
 */
export function verifyDeployedBuild(
  pluginRoot: string,
  pluginName: string,
  user: string,
  host: string,
): BuildHashResult {
  let localManifest: ManifestEntry[];
  try {
    localManifest = localBuildManifest(pluginRoot);
  } catch (err) {
    return {
      matches: null,
      localHash: null,
      remoteHash: null,
      localCount: 0,
      remoteCount: 0,
      reason: `could not read the local build under ${pluginRoot}: ${(err as Error).message}`,
    };
  }
  if (localManifest.length === 0) {
    return {
      matches: null,
      localHash: null,
      remoteHash: null,
      localCount: 0,
      remoteCount: 0,
      reason: `no deploy sources found under ${pluginRoot} -- run plugin_build first`,
    };
  }
  const localHash = combineManifest(localManifest);

  const targetDir = `~/homebrew/plugins/${pluginName}`;
  const entries = listDeploySources(pluginRoot);
  const cmd = remoteHashCommand(user, host, targetDir, entries);
  let output = "";
  try {
    output = String(
      proc.execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], shell: shell() }) ?? "",
    );
  } catch (err) {
    const e = err as { stdout?: unknown; stderr?: unknown; message?: string };
    output = String(e.stdout ?? "");
    if (!output.trim()) {
      const stderr = String(e.stderr ?? "");
      if (MISSING_DIR.test(stderr)) {
        return {
          matches: false,
          localHash,
          remoteHash: null,
          localCount: localManifest.length,
          remoteCount: 0,
          reason: `${targetDir} does not exist on the Deck -- the plugin has not been deployed there`,
        };
      }
      return {
        matches: null,
        localHash,
        remoteHash: null,
        localCount: localManifest.length,
        remoteCount: 0,
        reason: `could not read the deployed build on the Deck: ${stderr.trim() || e.message || "ssh failed"}`,
      };
    }
  }

  const remoteManifest = parseHashOutput(output);
  const remoteHash = combineManifest(remoteManifest);
  const matches = localHash === remoteHash;
  return {
    matches,
    localHash,
    remoteHash,
    localCount: localManifest.length,
    remoteCount: remoteManifest.length,
    reason: matches
      ? undefined
      : `local build has ${localManifest.length} file(s) (hash ${localHash.slice(0, 12)}...), the Deck's ` +
        `${targetDir} hashes ${remoteManifest.length} file(s) to ${remoteHash.slice(0, 12)}... -- redeploy`,
  };
}

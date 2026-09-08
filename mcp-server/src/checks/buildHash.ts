/**
 * checks.buildHash -- a fingerprint of the plugin bundle a check was saved
 * against.
 *
 * A saved check pins the landings a sweep or runSequence produced. Those
 * landings are a property of the built plugin, not of the Deck or the day it
 * ran, so a replay needs a cheap, deterministic way to tell "this is the same
 * build the check passed against" from "this is a different build, so a diff
 * here proves nothing either way". Wall-clock time, a version string a
 * developer forgot to bump, and a git commit that does not cover an untracked
 * local edit are all the wrong answer to that question -- the only thing that
 * actually determines what deck_sweep or deck_runSequence will see is the
 * bytes that get deployed.
 *
 * So this hashes exactly the files `deck_deploy` would copy to the Deck --
 * {@link listDeploySources}, the same list the deploy path already uses, not a
 * second guess at what "the build" means -- sorted for a stable order and
 * fed through one sha256 as (relative path, NUL, content, NUL) triples so a
 * renamed-but-identical file and a same-name-different-content file both
 * change the digest.
 *
 * Deliberately NOT included: file mtimes (touch a file without changing it
 * and the hash must not move), and anything outside DEPLOY_COPY_ENTRIES plus
 * the root .py helpers (a README edit must not invalidate every check).
 */
import crypto from "crypto";
import fs from "fs";
import path from "path";

import { listDeploySources } from "../deploy/copyManifest.js";

export interface BuildHashResult {
  /** "sha256:<hex>" -- prefixed so a check file's `buildHash` is self-describing. */
  hash: string;
  /** Relative paths that were hashed, sorted. Informational: lets a report say what was fingerprinted. */
  inputs: string[];
}

/** Depth-first, alphabetical file listing under `pluginRoot`, relative paths only. */
function collectFiles(pluginRoot: string, rel: string, out: string[]): void {
  const abs = path.join(pluginRoot, rel);
  let st: fs.Stats;
  try {
    st = fs.statSync(abs);
  } catch {
    return; // a listed entry that vanished between listing and hashing: skip, don't crash
  }
  if (st.isDirectory()) {
    for (const entry of fs.readdirSync(abs).sort()) {
      collectFiles(pluginRoot, path.join(rel, entry), out);
    }
  } else if (st.isFile()) {
    out.push(rel);
  }
}

/**
 * Fingerprint of everything `deck_deploy` would ship for `pluginRoot`.
 *
 * Pure with respect to anything but the filesystem: same files, same bytes,
 * same hash, on any machine, any run, any time of day.
 */
export function computeBuildHash(pluginRoot: string): BuildHashResult {
  const files: string[] = [];
  for (const entry of listDeploySources(pluginRoot)) {
    collectFiles(pluginRoot, entry, files);
  }
  files.sort((a, b) => a.localeCompare(b));

  const digest = crypto.createHash("sha256");
  for (const rel of files) {
    // Forward slashes so the hash does not change just because a check was
    // saved on Windows and replayed on Linux or vice versa.
    digest.update(rel.split(path.sep).join("/"));
    digest.update("\0");
    digest.update(fs.readFileSync(path.join(pluginRoot, rel)));
    digest.update("\0");
  }
  return { hash: `sha256:${digest.digest("hex")}`, inputs: files };
}

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
 * The fingerprint itself lives in ../deck/buildHash.ts; this file is a thin
 * adapter onto it. That was not true at first. This module and that one were
 * written in the same session by two lanes that each needed "hash the files
 * deck_deploy would ship", and each produced a correct-but-different number
 * for the same tree -- measured on example-plugin, sha256:2f4ef12a... here
 * against b70fcb14... there. Two fingerprints that disagree are worse than
 * one that is imperfect: deck_checkReady would report "the deployed build
 * matches" while deck_saveCheck stamped a different value for the same bytes,
 * and those two facts are at their most useful together ("this check passed
 * against the build you are running").
 *
 * ../deck/buildHash.ts won for a structural reason, not a stylistic one. Its
 * two-stage shape -- hash each file, then hash the sorted `path:sha256` lines
 * -- is the only one that can also be computed *on the Deck*, where
 * `sha256sum` hands back one digest per file and there is no way to stream
 * every file's bytes through a single hasher without shipping a script. This
 * module's one-pass stream could never answer "is the build on the Deck the
 * one on my PC", so unifying the other way would have cost that comparison
 * outright. Kept from this side: the `sha256:` prefix, so a value sitting in
 * a check file says what it is, and the input list, so a post-mortem can say
 * what was fingerprinted.
 *
 * Because the number changed, CHECK_FORMAT_VERSION went to 2 in the same
 * commit. A check file written before this carries the old algorithm's hash
 * and would otherwise report a build mismatch for a build that never changed
 * -- the exact false alarm this fingerprint exists to prevent.
 *
 * Deliberately NOT included: file mtimes (touch a file without changing it
 * and the hash must not move), and anything outside DEPLOY_COPY_ENTRIES plus
 * the root .py helpers (a README edit must not invalidate every check).
 */
import { combineManifest, localBuildManifest } from "../deck/buildHash.js";

export interface BuildHashResult {
  /** "sha256:<hex>" -- prefixed so a check file's `buildHash` is self-describing. */
  hash: string;
  /** Relative paths that were hashed, sorted. Informational: lets a report say what was fingerprinted. */
  inputs: string[];
}

/**
 * Fingerprint of everything `deck_deploy` would ship for `pluginRoot`.
 *
 * Pure with respect to anything but the filesystem: same files, same bytes,
 * same hash, on any machine, any run, any time of day. Paths come back
 * forward-slashed from the manifest, so a check saved on Windows and replayed
 * on Linux fingerprints and reads identically.
 */
export function computeBuildHash(pluginRoot: string): BuildHashResult {
  const manifest = localBuildManifest(pluginRoot);
  return {
    hash: `sha256:${combineManifest(manifest)}`,
    inputs: manifest.map((entry) => entry.path),
  };
}

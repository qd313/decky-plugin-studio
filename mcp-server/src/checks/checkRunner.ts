/**
 * checks.checkRunner -- save a check from a live sweep/runSequence call, and
 * replay every check in a directory against a fresh run.
 *
 * This is the seam every test below fakes: {@link SaveCheckOptions.runSweep} /
 * {@link ReplayChecksOptions.runSweep} (and the runSequence equivalents)
 * default to the REAL functions in deck/sweep.ts and deck/runSequence.ts,
 * which need a live Deck. A test that wants to exercise the LOOP -- save
 * writes a file, replay reads it back, reruns, diffs -- without a Deck
 * substitutes a function that returns a canned result instead. The pure
 * per-check comparison in checkFile.ts needs no seam at all: it never calls
 * either tool, which is what makes it possible to pin the diff behaviour
 * exactly without any of this.
 */
import fs from "fs";
import path from "path";

import { sweep, SweepOptions, SweepResult } from "../deck/sweep.js";
import { runSequence, RunSequenceOptions, RunSequenceResult } from "../deck/runSequence.js";
import { computeBuildHash } from "./buildHash.js";
import {
  CHECK_FORMAT_VERSION,
  CheckFile,
  CheckFileError,
  ReplayOutcome,
  RunSequenceRunOptions,
  SweepRunOptions,
  diffCheck,
  normalizeRunSequenceResult,
  normalizeSweepResult,
  validateCheckFile,
} from "./checkFile.js";

/** A check's name becomes this file under a checks directory. Same sanitizing as sweep/runSequence's own evidence names. */
export function checkFileName(name: string): string {
  return `${name.replace(/[^A-Za-z0-9._-]/g, "_")}.json`;
}

export function checkFilePath(checksDir: string, name: string): string {
  return path.join(checksDir, checkFileName(name));
}

export function saveCheckFile(filePath: string, check: CheckFile): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(check, null, 2) + "\n", "utf8");
}

/**
 * Read one check file, or throw {@link CheckFileError} with a message a
 * person can act on. Never lets a bare JSON.parse or fs error escape.
 */
export function loadCheckFile(filePath: string): CheckFile {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (err) {
    throw new CheckFileError(`Could not read check file ${filePath}: ${(err as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new CheckFileError(
      `${filePath} is not valid JSON -- it looks truncated or corrupted (${(err as Error).message}).`,
    );
  }
  return validateCheckFile(parsed, filePath);
}

export function listCheckFiles(checksDir: string): string[] {
  if (!fs.existsSync(checksDir)) return [];
  return fs
    .readdirSync(checksDir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => path.join(checksDir, f));
}

// ---------------------------------------------------------------------------
// Save
// ---------------------------------------------------------------------------

export type SaveCheckOptions =
  | {
      name: string;
      tool: "deck_sweep";
      checksDir: string;
      pluginRoot: string;
      sweepOptions?: SweepOptions;
      /** Test-only seam: substitutes the call to deck.sweep. Production code and the MCP tool never set this. */
      runSweep?: typeof sweep;
    }
  | {
      name: string;
      tool: "deck_runSequence";
      checksDir: string;
      pluginRoot: string;
      sequenceOptions: RunSequenceOptions;
      /** Test-only seam: substitutes the call to deck.runSequence. Production code and the MCP tool never set this. */
      runRunSequence?: typeof runSequence;
    };

export interface SaveCheckResult {
  ok: boolean;
  reason?: string;
  filePath: string | null;
  check: CheckFile | null;
  /** The raw tool result the check was (or would have been) built from, so a caller can inspect it even on refusal. */
  result: SweepResult | RunSequenceResult | null;
}

/**
 * Run the named tool for real (or via the test seam) and -- only if it
 * completed cleanly -- save its normalized landings as a named check.
 *
 * A run that did not complete (a press failed, the Deck was unreachable, the
 * killswitch fired) is refused rather than saved: a check records what
 * "right" looks like, and a broken run is not that, however faithfully it
 * would replay against itself.
 */
export async function saveCheck(opts: SaveCheckOptions): Promise<SaveCheckResult> {
  const buildHash = computeBuildHash(opts.pluginRoot);
  const filePath = checkFilePath(opts.checksDir, opts.name);

  if (opts.tool === "deck_sweep") {
    const doSweep = opts.runSweep ?? sweep;
    const sweepOptions: SweepOptions = { ...opts.sweepOptions, writeEvidence: false };
    const result = await doSweep(sweepOptions);
    if (!result.ok) {
      return {
        ok: false,
        reason: `deck_sweep did not complete cleanly, so nothing was saved: ${result.summary}`,
        filePath: null,
        check: null,
        result,
      };
    }
    const runOptions: SweepRunOptions = {
      direction: result.pattern.direction,
      returnTrip: result.pattern.returnTrip,
      lanes: result.pattern.lanes,
      laneButton: result.pattern.laneButton,
      budget: result.pattern.budget,
      stallLimit: result.pattern.stallLimit,
      acquireFocus: opts.sweepOptions?.acquireFocus !== false,
    };
    const check: CheckFile = {
      formatVersion: CHECK_FORMAT_VERSION,
      name: opts.name,
      tool: "deck_sweep",
      savedAt: new Date().toISOString(),
      buildHash: buildHash.hash,
      buildHashInputs: buildHash.inputs,
      runOptions,
      expected: normalizeSweepResult(result),
    };
    saveCheckFile(filePath, check);
    return { ok: true, filePath, check, result };
  }

  const doRunSequence = opts.runRunSequence ?? runSequence;
  const sequenceOptions: RunSequenceOptions = { ...opts.sequenceOptions, writeEvidence: false };
  const result = await doRunSequence(sequenceOptions);
  if (!result.ok) {
    return {
      ok: false,
      reason: `deck_runSequence did not complete cleanly, so nothing was saved: ${result.summary}`,
      filePath: null,
      check: null,
      result,
    };
  }
  const runOptions: RunSequenceRunOptions = {
    steps: sequenceOptions.steps,
    stopOnFailure: sequenceOptions.stopOnFailure !== false,
    mustReachText: sequenceOptions.mustReachText ?? [],
    requireVisible: sequenceOptions.requireVisible ?? false,
    acquireFocus: sequenceOptions.acquireFocus !== false,
  };
  const check: CheckFile = {
    formatVersion: CHECK_FORMAT_VERSION,
    name: opts.name,
    tool: "deck_runSequence",
    savedAt: new Date().toISOString(),
    buildHash: buildHash.hash,
    buildHashInputs: buildHash.inputs,
    runOptions,
    expected: normalizeRunSequenceResult(result),
  };
  saveCheckFile(filePath, check);
  return { ok: true, filePath, check, result };
}

// ---------------------------------------------------------------------------
// Replay
// ---------------------------------------------------------------------------

export interface ReplayChecksOptions {
  checksDir: string;
  pluginRoot: string;
  /** Replay only checks with these saved names (not filenames). Default: every check file in checksDir. */
  only?: string[];
  /** Passed through to every sweep/runSequence call this replay makes. */
  port?: string;
  cdpUrl?: string;
  /** Test-only seams: substitute the calls to deck.sweep / deck.runSequence. Production code and the MCP tool never set these. */
  runSweep?: typeof sweep;
  runRunSequence?: typeof runSequence;
}

export interface ReplayChecksResult {
  currentBuildHash: string;
  checked: ReplayOutcome[];
  /** Check files that could not even be read -- malformed or truncated. Never crashes the loop. */
  errors: Array<{ file: string; message: string }>;
  /** True only when there were no read errors and every check both matched its build hash and had no diff. */
  ok: boolean;
  summary: string;
}

/**
 * Reread every saved check in `checksDir`, rerun the tool it names, and diff
 * each against what was saved. The loop a person used to do by hand, after
 * every build, one check at a time.
 */
export async function replayChecks(opts: ReplayChecksOptions): Promise<ReplayChecksResult> {
  const doSweep = opts.runSweep ?? sweep;
  const doRunSequence = opts.runRunSequence ?? runSequence;
  const buildHash = computeBuildHash(opts.pluginRoot);

  const files = listCheckFiles(opts.checksDir);
  const checked: ReplayOutcome[] = [];
  const errors: Array<{ file: string; message: string }> = [];

  for (const file of files) {
    let check: CheckFile;
    try {
      check = loadCheckFile(file);
    } catch (err) {
      errors.push({ file, message: (err as Error).message });
      continue;
    }
    if (opts.only && !opts.only.includes(check.name)) continue;

    if (check.tool === "deck_sweep") {
      const result = await doSweep({
        ...check.runOptions,
        port: opts.port,
        cdpUrl: opts.cdpUrl,
        writeEvidence: false,
      });
      checked.push(diffCheck(check, buildHash.hash, result));
    } else {
      const result = await doRunSequence({
        ...check.runOptions,
        port: opts.port,
        cdpUrl: opts.cdpUrl,
        writeEvidence: false,
      });
      checked.push(diffCheck(check, buildHash.hash, result));
    }
  }

  const failing = checked.filter((c) => !c.ok);
  const ok = errors.length === 0 && failing.length === 0;
  const summary =
    errors.length === 0 && checked.length === 0
      ? "no checks found"
      : [
          `${checked.length - failing.length}/${checked.length} check(s) passed`,
          errors.length ? `${errors.length} check file(s) could not be read` : null,
          failing.length ? `failing: ${failing.map((f) => f.name).join(", ")}` : null,
        ]
          .filter(Boolean)
          .join("; ");

  return { currentBuildHash: buildHash.hash, checked, errors, ok, summary };
}

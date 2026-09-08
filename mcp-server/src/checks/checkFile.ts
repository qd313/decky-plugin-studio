/**
 * checks.checkFile -- the named check file itself, and the diff that decides
 * whether a replay of it still holds.
 *
 * Plan: "a D-pad bug locked by a check that fails without the fix, reached
 * once, by hand" -- today the fix is verified with a sweep or a runSequence,
 * a person reads the report, and then nothing keeps that verdict true. This
 * is the file format that lets a person save what they just confirmed and
 * the loop (checkRunner.ts) that reruns it later and says whether it is still
 * true.
 *
 * WHAT'S IN THE FILE, DELIBERATELY.
 *
 * `expected` is a NORMALIZED projection of the tool's own result -- built by
 * {@link normalizeSweepResult} / {@link normalizeRunSequenceResult} below, not
 * a raw dump of SweepResult/RunSequenceResult. Both normalizers throw away
 * exactly the fields that legitimately vary run to run without the plugin
 * having changed at all, because a check that fails for a reason unrelated to
 * the plugin is worse than no check -- it trains people to ignore red. See
 * each normalizer's own comment for the field-by-field reasoning.
 *
 * `buildHash` is recorded (see buildHash.ts) precisely so a replay can tell
 * "this changed" (same build, different landing -- a real regression) from
 * "this was never true here" (different build -- the check has simply never
 * been verified against what is running now, and a landing diff against it
 * would be a comparison between two different plugins, not a finding).
 *
 * `runOptions` is exactly what a replay needs to hand back to `sweep()` or
 * `runSequence()` to reproduce the same walk -- the direction, the steps,
 * the budgets -- so replaying a check never means re-deriving how it was run.
 */
import type { WalkDirection } from "../deck/walkTo.js";
import type { LaneButton, SweepReport, SweepResult, SweepStop, SweepLeg, SweepTotals, NotVisibleStop } from "../deck/sweep.js";
import type {
  RunSequenceResult,
  StepResult,
  SequenceStep,
  CycleReport,
} from "../deck/runSequence.js";
import type { Visibility } from "../deck/readFocus.js";

/**
 * Bumped 1 -> 2 on 2026-09-08, when `buildHash` changed meaning: checks/buildHash.ts
 * stopped computing its own fingerprint and now delegates to deck/buildHash.ts, which
 * produces a different (equally correct) number for the same tree. A version 1 file
 * therefore carries a hash that cannot be compared with anything this build computes,
 * and replaying one would report a build mismatch for a build that never changed.
 * Rejecting it loudly is the point of this constant.
 */
export const CHECK_FORMAT_VERSION = 2 as const;

export type CheckedTool = "deck_sweep" | "deck_runSequence";

/** The categorical half of Visibility -- what a person would call true or false. */
export interface VisibilityForCheck {
  verdict: Visibility["verdict"];
  coveredBy: string | null;
  clippedBy: string | null;
}

/**
 * `visiblePercent` and the raw 3x3 `points` tally are sampled from
 * `elementFromPoint` at whatever instant the settle poll happened to land --
 * a control mid-transition can read 89% on one run and 100% on the next
 * without anything about the plugin changing. `verdict` (visible / partial /
 * covered / offscreen), `coveredBy` and `clippedBy` are the categorical facts
 * a person actually cares about and do not carry that noise, so those are
 * what gets compared; the percent is dropped here rather than trusted to
 * reproduce byte for byte the way the rest of a sweep report does.
 */
function trimVisibility(v: Visibility | null | undefined): VisibilityForCheck | null {
  if (!v) return null;
  return { verdict: v.verdict, coveredBy: v.coveredBy, clippedBy: v.clippedBy };
}

// ---------------------------------------------------------------------------
// deck_sweep
// ---------------------------------------------------------------------------

export interface SweepRunOptions {
  direction: WalkDirection;
  returnTrip: boolean;
  lanes: number;
  laneButton: LaneButton;
  budget: number;
  stallLimit: number;
  acquireFocus: boolean;
}

export type SweepStopExpected = Omit<SweepStop, "visibility"> & { visibility: VisibilityForCheck | null };
export type NotVisibleStopExpected = Omit<NotVisibleStop, "visiblePercent">;

export interface SweepExpected {
  pattern: SweepReport["pattern"];
  ok: boolean;
  reason?: string;
  stopped: boolean;
  totals: SweepTotals;
  notVisible: NotVisibleStopExpected[];
  legs: SweepLeg[];
  stops: SweepStopExpected[];
}

/**
 * The diffable projection of a sweep result.
 *
 * Everything else in {@link SweepReport} -- `pattern`, `ok`, `reason`,
 * `stopped`, `totals`, `notVisible`, `legs`, `stops` minus each stop's
 * `visiblePercent` -- is kept, because the module that produces it already
 * documents that the report "reproduces byte-for-byte across runs on the
 * same build" (sweep.ts, and confirmed by summarize()'s own test coverage).
 * `durationMs`, `evidenceFile`, `pressRetries`, `fidelity`, `acquired` and
 * `summary` never enter here at all because they live on SweepResult, not
 * SweepReport, and sweep.ts's own evidence writer already treats them as the
 * "result, not report" half that would dirty a diff -- see its `finish()`.
 */
export function normalizeSweepResult(result: SweepReport | SweepResult): SweepExpected {
  return {
    pattern: result.pattern,
    ok: result.ok,
    reason: result.reason,
    stopped: result.stopped,
    totals: result.totals,
    notVisible: result.notVisible.map(({ visiblePercent: _drop, ...rest }) => rest),
    legs: result.legs,
    stops: result.stops.map((s) => ({ ...s, visibility: trimVisibility(s.visibility) })),
  };
}

// ---------------------------------------------------------------------------
// deck_runSequence
// ---------------------------------------------------------------------------

export interface RunSequenceRunOptions {
  steps: SequenceStep[];
  stopOnFailure: boolean;
  mustReachText: string[];
  requireVisible: boolean;
  acquireFocus: boolean;
}

export interface RunSequenceStepExpected {
  index: number;
  label: string;
  press: string[];
  expect: string | null;
  ok: boolean;
  pass: boolean;
  moved: boolean;
  matched: boolean | null;
  from: string;
  to: string;
  focusKey: string | null;
  visible: boolean | null;
  visibility: VisibilityForCheck | null;
}

export interface RunSequenceExpected {
  /**
   * Recomputed as `passed === totalSteps && ranSteps === totalSteps` rather
   * than copied from `result.ok`: the tool's own `ok` also goes false when a
   * human throws the killswitch mid-run, which is a fact about an operator,
   * not about the plugin, and must not read as a landing changing.
   */
  ok: boolean;
  ranSteps: number;
  totalSteps: number;
  passed: number;
  failed: number;
  visited: string[];
  cycle: CycleReport | null;
  neverReached: string[];
  stopsFocusedButNotVisible: number;
  notVisibleStops: string[];
  steps: RunSequenceStepExpected[];
}

function normalizeStep(s: StepResult): RunSequenceStepExpected {
  return {
    index: s.index,
    label: s.label,
    press: s.press,
    expect: s.expect,
    ok: s.ok,
    pass: s.pass,
    moved: s.moved,
    matched: s.matched,
    from: s.from,
    to: s.to,
    focusKey: s.focusKey,
    visible: s.visible,
    visibility: trimVisibility(s.visibility),
  };
}

/**
 * The diffable projection of a runSequence result.
 *
 * Excluded, and why each is incidental rather than a fact about the plugin:
 *
 *  - `settled` / `settleMs` (per step) -- a race against a wall-clock
 *    timeout. The same UI can settle in 40ms on one run and 60ms on a busier
 *    one; only whether the run WAITED FOR IT (already captured by `pass`
 *    when `requireVisible` is set, and by `matched`/`moved` regardless) says
 *    anything about the plugin.
 *  - `diagnosis` / `reason` (per step and run-level) -- prose generated FROM
 *    the structured fields already kept here. Comparing prose means a wording
 *    change in runSequence.ts itself (not the plugin) fails every check that
 *    ever printed that sentence.
 *  - `durationMs`, `evidenceFile`, `fidelity`, `acquired`, `stopped`,
 *    `summary` (run-level) -- facts about how THIS run happened to be carried
 *    out (an SSH tunnel's timing, whether the ring needed placing, whether a
 *    human intervened), not about what the plugin showed. `reason` at the run
 *    level is the same kind of prose as the per-step diagnosis and is dropped
 *    for the same reason.
 *
 * `visiblePercent` and `points` are dropped from each step's `visibility` for
 * the same render-timing reason given in {@link trimVisibility} -- applied
 * here too even though runSequence.ts makes no explicit byte-for-byte claim,
 * because the measurement is identical to sweep's.
 */
export function normalizeRunSequenceResult(result: RunSequenceResult): RunSequenceExpected {
  return {
    ok: result.passed === result.totalSteps && result.ranSteps === result.totalSteps,
    ranSteps: result.ranSteps,
    totalSteps: result.totalSteps,
    passed: result.passed,
    failed: result.failed,
    visited: result.visited,
    cycle: result.cycle,
    neverReached: result.neverReached,
    stopsFocusedButNotVisible: result.stopsFocusedButNotVisible,
    notVisibleStops: result.notVisibleStops,
    steps: result.steps.map(normalizeStep),
  };
}

// ---------------------------------------------------------------------------
// The check file
// ---------------------------------------------------------------------------

export interface CheckFileBase {
  formatVersion: typeof CHECK_FORMAT_VERSION;
  /** The check's own name -- also its filename, sanitized. */
  name: string;
  /** ISO timestamp of when the check was saved. Informational only -- NEVER compared by a replay. */
  savedAt: string;
  /** sha256 of the plugin bundle the check passed against. See buildHash.ts. */
  buildHash: string;
  /** Relative paths that went into buildHash, for a post-mortem. Informational only. */
  buildHashInputs: string[];
}

export interface SweepCheckFile extends CheckFileBase {
  tool: "deck_sweep";
  runOptions: SweepRunOptions;
  expected: SweepExpected;
}

export interface RunSequenceCheckFile extends CheckFileBase {
  tool: "deck_runSequence";
  runOptions: RunSequenceRunOptions;
  expected: RunSequenceExpected;
}

export type CheckFile = SweepCheckFile | RunSequenceCheckFile;

/** Thrown by {@link loadCheckFile} / {@link validateCheckFile} for a check file that cannot be trusted. */
export class CheckFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CheckFileError";
  }
}

const REQUIRED_FIELDS = ["formatVersion", "name", "tool", "buildHash", "runOptions", "expected"] as const;

/**
 * Validate a parsed JSON value as a {@link CheckFile}, or throw a
 * {@link CheckFileError} that names exactly what is wrong -- a malformed or
 * truncated file must be REJECTED WITH A CLEAR MESSAGE, never crash the
 * replay loop or silently read as "no diff".
 */
export function validateCheckFile(parsed: unknown, sourceLabel = "check file"): CheckFile {
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new CheckFileError(`${sourceLabel} is not a check: expected a JSON object at the top level.`);
  }
  const c = parsed as Record<string, unknown>;

  const missing = REQUIRED_FIELDS.filter((k) => !(k in c) || c[k] === undefined);
  if (missing.length) {
    throw new CheckFileError(
      `${sourceLabel} is missing required field(s): ${missing.join(", ")}. It may be truncated or hand-edited.`,
    );
  }
  if (c.formatVersion !== CHECK_FORMAT_VERSION) {
    // Version 1 is the one case worth naming, because the file is not corrupt and
    // the reader can fix it in one call -- silently comparing its old-algorithm hash
    // would look like a build regression rather than a format change.
    const advice =
      c.formatVersion === 1
        ? " Version 1 recorded a different build fingerprint, so its buildHash cannot be " +
          "compared with anything this build computes. Re-save the check with deck_saveCheck."
        : "";
    throw new CheckFileError(
      `${sourceLabel} has formatVersion ${JSON.stringify(c.formatVersion)}; this build only reads ${CHECK_FORMAT_VERSION}.${advice}`,
    );
  }
  if (typeof c.name !== "string" || !c.name.trim()) {
    throw new CheckFileError(`${sourceLabel} has no usable "name".`);
  }
  if (c.tool !== "deck_sweep" && c.tool !== "deck_runSequence") {
    throw new CheckFileError(
      `${sourceLabel} names an unknown tool ${JSON.stringify(c.tool)}; expected "deck_sweep" or "deck_runSequence".`,
    );
  }
  if (typeof c.buildHash !== "string" || !c.buildHash.trim()) {
    throw new CheckFileError(`${sourceLabel} has no "buildHash" -- it cannot be told apart from a check saved against a different build.`);
  }
  if (!c.runOptions || typeof c.runOptions !== "object") {
    throw new CheckFileError(`${sourceLabel}."runOptions" is missing or not an object -- there is nothing to replay.`);
  }
  if (!c.expected || typeof c.expected !== "object") {
    throw new CheckFileError(`${sourceLabel}."expected" is missing or not an object -- there is nothing to diff against.`);
  }
  if (c.tool === "deck_sweep") {
    const exp = c.expected as Record<string, unknown>;
    if (!Array.isArray(exp.stops) || !Array.isArray(exp.legs) || !exp.totals) {
      throw new CheckFileError(`${sourceLabel}."expected" is missing stops/legs/totals expected of a deck_sweep check.`);
    }
  } else {
    const exp = c.expected as Record<string, unknown>;
    if (!Array.isArray(exp.steps)) {
      throw new CheckFileError(`${sourceLabel}."expected" is missing "steps" expected of a deck_runSequence check.`);
    }
  }
  return c as unknown as CheckFile;
}

// ---------------------------------------------------------------------------
// Diffing a check against a fresh result
// ---------------------------------------------------------------------------

export interface CheckDiffEntry {
  /** Dotted/bracketed path into the normalized `expected` shape, e.g. `stops[3].label`. */
  path: string;
  expected: unknown;
  actual: unknown;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  if (isPlainObject(a) || isPlainObject(b)) {
    if (!isPlainObject(a) || !isPlainObject(b)) return false;
    const ak = Object.keys(a);
    const bk = Object.keys(b);
    if (ak.length !== bk.length) return false;
    return ak.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEqual(a[k], b[k]));
  }
  return false;
}

/** Recursive structural diff between two JSON-shaped values, collecting leaf-level differences. */
function deepDiff(expected: unknown, actual: unknown, prefix: string, out: CheckDiffEntry[]): void {
  if (deepEqual(expected, actual)) return;
  if (Array.isArray(expected) && Array.isArray(actual)) {
    const len = Math.max(expected.length, actual.length);
    for (let i = 0; i < len; i++) {
      const path = `${prefix}[${i}]`;
      if (i >= expected.length) out.push({ path, expected: undefined, actual: actual[i] });
      else if (i >= actual.length) out.push({ path, expected: expected[i], actual: undefined });
      else deepDiff(expected[i], actual[i], path, out);
    }
    return;
  }
  if (isPlainObject(expected) && isPlainObject(actual)) {
    const keys = new Set([...Object.keys(expected), ...Object.keys(actual)]);
    for (const k of keys) {
      deepDiff(expected[k], actual[k], prefix ? `${prefix}.${k}` : k, out);
    }
    return;
  }
  out.push({ path: prefix, expected, actual });
}

function fmt(v: unknown): string {
  if (v === undefined) return "(absent)";
  if (v === null) return "null";
  if (typeof v === "string") return JSON.stringify(v);
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

/**
 * Turn one structural diff entry into a sentence naming WHICH stop or step it
 * is about and expected-versus-actual -- the requirement is "a changed
 * landing is named specifically", not a bare JSON path.
 */
function describeDiff(check: CheckFile, d: CheckDiffEntry): string {
  const itemMatch = /^(stops|steps)\[(\d+)\](?:\.(.+))?$/.exec(d.path);
  if (itemMatch) {
    const [, collection, idxStr, field] = itemMatch;
    const idx = Number(idxStr);
    const isSweep = check.tool === "deck_sweep" && collection === "stops";
    const isSeq = check.tool === "deck_runSequence" && collection === "steps";
    if (isSweep) {
      const stops = (check.expected as SweepExpected).stops;
      const known = stops[idx];
      if (!field) {
        return d.expected === undefined
          ? `stop #${idx} appeared on replay that the saved check never had: ${fmt(d.actual)}`
          : `stop #${idx} from the saved check (${known ? known.label || "<unlabeled>" : "?"}) is missing from the replay`;
      }
      const ctx = known ? `lane ${known.lane}, leg ${known.leg}` : "a new stop";
      const who = known?.label ? ` "${known.label}"` : "";
      return `stop #${idx}${who} (${ctx}): ${field} expected ${fmt(d.expected)} but got ${fmt(d.actual)}`;
    }
    if (isSeq) {
      const steps = (check.expected as RunSequenceExpected).steps;
      const known = steps[idx];
      // The run's own 1-based step number (StepResult.index), not the array
      // position -- they usually coincide, but the step number is what a
      // person reading the run's own log actually sees.
      const stepNum = known?.index ?? idx + 1;
      const label = known?.label ?? `step ${stepNum}`;
      if (!field) {
        return d.expected === undefined
          ? `step ${stepNum} appeared on replay that the saved check never had: ${fmt(d.actual)}`
          : `step ${stepNum} ("${label}") from the saved check is missing from the replay`;
      }
      return `step ${stepNum} ("${label}"): ${field} expected ${fmt(d.expected)} but got ${fmt(d.actual)}`;
    }
  }
  return `${d.path}: expected ${fmt(d.expected)} but got ${fmt(d.actual)}`;
}

export interface ReplayOutcome {
  name: string;
  tool: CheckedTool;
  /** False when the check was never run against the current build -- see the module comment. */
  buildHashMatch: boolean;
  savedBuildHash: string;
  currentBuildHash: string;
  /** True only when buildHashMatch and no landing differs. */
  ok: boolean;
  diffs: CheckDiffEntry[];
  /** Human-readable, one per diff (or one explaining a build-hash mismatch). */
  messages: string[];
  summary: string;
}

/**
 * Compare a saved check against a fresh result for the SAME tool call.
 *
 * When the build hash does not match, no landing-level diff is computed at
 * all: comparing a check's expectations against a DIFFERENT build's result
 * would produce diffs that say nothing about whether the plugin regressed --
 * exactly the "this was never true here" case the design calls out. The
 * caller gets that fact plainly instead, and can re-save the check once this
 * build is trusted.
 */
export function diffCheck(
  check: CheckFile,
  currentBuildHash: string,
  actualResult: SweepResult | SweepReport | RunSequenceResult,
): ReplayOutcome {
  if (check.buildHash !== currentBuildHash) {
    return {
      name: check.name,
      tool: check.tool,
      buildHashMatch: false,
      savedBuildHash: check.buildHash,
      currentBuildHash,
      ok: false,
      diffs: [],
      messages: [],
      summary:
        `"${check.name}" was saved against build ${check.buildHash}, but the current build is ${currentBuildHash}. ` +
        "This replay cannot say whether the plugin changed -- only that this check has never been verified " +
        "against what is running now. Re-save it once you trust this build.",
    };
  }

  const diffs: CheckDiffEntry[] = [];
  if (check.tool === "deck_sweep") {
    deepDiff(check.expected, normalizeSweepResult(actualResult as SweepResult), "", diffs);
  } else {
    deepDiff(check.expected, normalizeRunSequenceResult(actualResult as RunSequenceResult), "", diffs);
  }
  const messages = diffs.map((d) => describeDiff(check, d));
  return {
    name: check.name,
    tool: check.tool,
    buildHashMatch: true,
    savedBuildHash: check.buildHash,
    currentBuildHash,
    ok: diffs.length === 0,
    diffs,
    messages,
    summary:
      diffs.length === 0
        ? `"${check.name}": no diff -- every landing matches the saved check`
        : `"${check.name}": ${diffs.length} difference(s) from the saved check -- ${messages[0]}${diffs.length > 1 ? ` (+${diffs.length - 1} more)` : ""}`,
  };
}

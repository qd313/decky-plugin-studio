/**
 * deck.runSequence -- drive a list of presses and report what Steam did at each one.
 *
 * This is the piece that turns the oracle and the bridge into something that runs
 * unattended. Before it, every press was a separate tool call: a fresh SSH tunnel
 * (~350 ms of pure setup), a result a human had to read, and a decision a human
 * had to make before the next press. Twenty presses meant twenty round trips
 * through a person. That is the gap between "the rig can press and read" and
 * plan 19 § 4's acceptance bar, "one command, nobody touches the Deck".
 *
 * Three things it adds beyond looping over assertFocusMove:
 *
 *   1. ONE TUNNEL for the whole run. assertFocusMove takes `cdpUrl` precisely so
 *      a caller can own the tunnel; this is that caller.
 *
 *   2. CYCLE DETECTION. A focus graph can fail by trapping the ring in a region
 *      that has no way out -- every individual press "works" (moved: true,
 *      matched: true) while the run as a whole is broken. No per-step assertion
 *      can see that, because the defect is a property of the path, not of any
 *      one edge. The report is a MEASUREMENT, not a verdict: it says which key
 *      repeated, what the loop was, and whether anything new was reached
 *      afterwards. Whether that constitutes a bug is the caller's call -- a tab
 *      bar that wraps is a legitimate cycle.
 *
 *   3. AN EVIDENCE FILE. A run nobody watched has to leave something behind that
 *      a person can read later, or it did not happen.
 *
 * Deliberately NOT here: retries. If a press does not land, that is the finding.
 * Re-pressing until it works is how a flaky focus graph gets marked green.
 */
import fs from "fs";
import path from "path";

import { openCdpTunnel } from "./cdpTunnel.js";
import { readFocusAt, ReadFocusResult, FocusElement } from "./readFocus.js";
import { assertFocusMove } from "./assertFocusMove.js";
import { focusKey, describe, describeElement, labelOfElement } from "./focusKey.js";
import { automationStopped, stoppedMessage } from "./killswitch.js";
import { acquireFocusIfUnowned } from "./walkTo.js";
import { pressButton } from "./pressButton.js";
import { getWorkspaceArtifactsDir, timestamp } from "../tools/captureOrchestrator.js";

export interface SequenceStep {
  /** Button(s) for this step, as for deck_pressButton. A list is a chord. */
  press: string | string[];
  /** CSS selector focus should match afterwards. Omit to just record where it went. */
  expect?: string;
  /** Human name for this step, used in the log and the summary. */
  label?: string;
  holdMs?: number;
  settleTimeoutMs?: number;
}

export interface StepResult {
  index: number;
  label: string;
  press: string[];
  expect: string | null;
  /** Did the step execute at all -- press delivered and focus read? */
  ok: boolean;
  /** Did the step's assertion hold? A step with no `expect` passes if it executed. */
  pass: boolean;
  moved: boolean;
  matched: boolean | null;
  from: string;
  to: string;
  focusKey: string | null;
  settled: boolean;
  settleMs: number;
  diagnosis: string;
  reason?: string;
}

export interface CycleReport {
  /** The focus identity that showed up twice. */
  key: string;
  /** Step numbers where it was seen (0 = the read taken before any press). */
  seenAt: number[];
  /** The elements traversed between those two visits, in order. */
  loop: string[];
  /** After the loop closed, did any later step reach an element not already seen? */
  escaped: boolean;
  /**
   * How many steps ran after the loop closed. `escaped: false` with 0 steps here
   * means the run simply ended, NOT that the ring was trapped -- the difference
   * matters and collapsing it would manufacture findings.
   */
  stepsAfterLoop: number;
}

export interface RunSequenceOptions {
  steps: SequenceStep[];
  /** Stop at the first step that fails its assertion. Default true. */
  stopOnFailure?: boolean;
  /**
   * Labels that must show up somewhere in the run. Matched case-insensitively
   * against each visited control's computed name (see FocusElement.label). This
   * is the cheap way to express "Retry must stay reachable" without a DOM query
   * per candidate.
   */
  mustReachText?: string[];
  /** Serial port of the bridge's COM side. */
  port?: string;
  /** Existing CDP endpoint; omit to open a temporary tunnel for the run. */
  cdpUrl?: string;
  /** Name for the evidence file. Defaults to a timestamp. */
  runName?: string;
  /** Set false to skip writing an evidence file. Default true. */
  writeEvidence?: boolean;
  /**
   * When nothing owns the ring, spend one press placing it before the run
   * starts, exactly like deck_walkTo's option of the same name -- both tools
   * start from the same platform state (doc 03: unowned right after a plugin
   * opens, and after an Ask finishes). Default true, for the same reason
   * walkTo defaults it true: the workaround was a bare deck_pressButton before
   * every run, which wastes a press and leaves the ring somewhere the caller
   * did not choose. Set false when the unowned state is itself what you are
   * testing.
   */
  acquireFocus?: boolean;
  /**
   * Test-only seam: substitutes the press used to place an unowned ring, so
   * the acquire path can be exercised without the bridge board. Production
   * code and the MCP tool never set this -- they always use the real press.
   */
  acquirePressFn?: typeof pressButton;
}

export interface RunSequenceResult {
  ok: boolean;
  reason?: string;
  fidelity: "steam-routed" | null;
  steps: StepResult[];
  ranSteps: number;
  totalSteps: number;
  passed: number;
  failed: number;
  /** Distinct elements the ring visited, in first-seen order. */
  visited: string[];
  cycle: CycleReport | null;
  /** Entries of `mustReachText` that never appeared. */
  neverReached: string[];
  /**
   * True when the run ended because the killswitch was thrown, not because it
   * finished or failed. A stopped run is not a failed run: the steps that ran
   * are still evidence, and the ones that did not were never attempted.
   */
  stopped: boolean;
  evidenceFile: string | null;
  durationMs: number;
  /** True when a press was spent placing an unowned ring before the run began. */
  acquired: boolean;
  summary: string;
}

export interface Visit {
  step: number;
  key: string | null;
  label: string;
  el: FocusElement | null;
}

/**
 * First focus identity the ring genuinely returns to, with the path between the
 * two visits.
 *
 * "Genuinely returns to" excludes a key that merely repeats on consecutive
 * reads. That case is a press which moved nothing -- a dead end at the bottom of
 * a list, say -- and it is already reported per step as `moved: false`. The
 * first hardware run of this tool walked into the bottom of the bonsAI panel and
 * three no-op presses got reported as a four-visit cycle, which is noise
 * dressed up as a finding. A loop has to leave and come back, so there must be a
 * different element somewhere strictly between the two visits.
 *
 * Keys are scanned in first-appearance order, and the span runs from a key's
 * first occurrence to its last, so the report names the outermost loop rather
 * than whichever repeat happens to be found first.
 */
function findCycle(visits: Visit[]): CycleReport | null {
  const seen = new Map<string, number[]>();
  visits.forEach((v, i) => {
    if (!v.key) return;
    const at = seen.get(v.key);
    if (at) at.push(i);
    else seen.set(v.key, [i]);
  });

  for (const [key, at] of seen) {
    if (at.length < 2) continue;
    const first = at[0];
    const last = at[at.length - 1];
    const wentElsewhere = visits.slice(first + 1, last).some((v) => v.key && v.key !== key);
    if (!wentElsewhere) continue;

    const before = new Set(visits.slice(0, last + 1).map((v) => v.key));
    const after = visits.slice(last + 1);
    return {
      key,
      seenAt: at.map((i) => visits[i].step),
      loop: visits.slice(first, last + 1).map((v) => v.label),
      escaped: after.some((v) => v.key && !before.has(v.key)),
      stepsAfterLoop: after.length,
    };
  }
  return null;
}

/**
 * Match against the control's computed name, not a bag of every string near it.
 *
 * An ancestor's text still counts, and it has to: on a Deck the ring lands
 * *inside* a ToggleField, on a div with no text of its own, so matching only the
 * focused element's own text reports "never reached" for a control the ring is
 * demonstrably sitting on (measured against FOCUS-GRAPH-DEV-KB-01, 2026-08-26,
 * where both targets were reached and both were reported missed).
 *
 * What changed on 2026-08-28 is that it is no longer a CONCATENATION. Joining
 * text + ariaLabel + ownerText into one haystack meant `mustReachText` could be
 * satisfied by any text anywhere above the ring -- with an icon-only control
 * that inherited a whole pane, every needle in that pane "was reached". Same
 * false-success family as P1-10, and `neverReached` is exactly the field a run
 * is trusted on. labelOfElement resolves one name, with the container guard.
 */
function matchesText(el: FocusElement | null, needle: string): boolean {
  const label = labelOfElement(el);
  if (!label) return false;
  return label.toLowerCase().includes(needle.toLowerCase());
}

export async function runSequence(opts: RunSequenceOptions): Promise<RunSequenceResult> {
  const started = Date.now();
  const steps = opts.steps ?? [];
  const stopOnFailure = opts.stopOnFailure !== false;
  const mustReach = opts.mustReachText ?? [];

  const base: RunSequenceResult = {
    ok: false,
    fidelity: null,
    steps: [],
    ranSteps: 0,
    totalSteps: steps.length,
    passed: 0,
    failed: 0,
    visited: [],
    cycle: null,
    neverReached: mustReach,
    stopped: false,
    evidenceFile: null,
    durationMs: 0,
    acquired: false,
    summary: "",
  };

  if (steps.length === 0) {
    return { ...base, reason: "No steps given.", summary: "nothing to run" };
  }

  // Checked before the tunnel is opened, not just before the first press: a
  // stopped rig should not be spending 350 ms of SSH setup on a run that cannot
  // deliver a single step.
  const latchedBefore = automationStopped();
  if (latchedBefore) {
    return {
      ...base,
      stopped: true,
      reason: stoppedMessage(latchedBefore),
      durationMs: Date.now() - started,
      summary: "refused: Deck automation is stopped, so nothing was pressed",
    };
  }

  let cdpBase = opts.cdpUrl;
  let closeTunnel: (() => void) | null = null;
  if (!cdpBase) {
    try {
      const tunnel = await openCdpTunnel();
      cdpBase = tunnel.base;
      closeTunnel = tunnel.close;
    } catch (err) {
      return {
        ...base,
        reason: (err as Error).message,
        durationMs: Date.now() - started,
        summary: "could not reach the Deck, so nothing was pressed",
      };
    }
  }

  const results: StepResult[] = [];
  const visits: Visit[] = [];
  let stoppedMidRun = false;
  let acquired = false;

  try {
    // Step 0 is the state the run starts from. Without it a loop back to the
    // starting element would look like a fresh visit.
    let first = await readFocusAt(cdpBase, 10_000);

    // Unowned ring: one press places it rather than moving it, so spend that
    // press here and re-read before the run proper begins. Same mechanism and
    // same default as deck_walkTo -- see acquireFocusIfUnowned.
    if (opts.acquireFocus !== false) {
      const outcome = await acquireFocusIfUnowned(first, {
        cdpBase,
        direction: "DOWN",
        port: opts.port,
        pressFn: opts.acquirePressFn,
      });
      first = outcome.focus;
      acquired = outcome.acquired;
    }

    if (!first.ok) {
      return {
        ...base,
        reason: first.reason,
        durationMs: Date.now() - started,
        acquired,
        summary: acquired
          ? `spent one press trying to place an unowned ring and focus is still unreadable: ${first.reason ?? ""}`
          : "could not read focus before the run started, so nothing was pressed. " +
            "If the ring is unowned -- which it is right after a plugin opens or an Ask finishes -- " +
            "one press places it; acquireFocus does that automatically and is on by default.",
      };
    }
    visits.push({ step: 0, key: focusKey(first), label: describe(first), el: first.gpfocus });

    for (let i = 0; i < steps.length; i++) {
      // The press itself refuses on the latch too, so no press can escape this.
      // Checking here as well is what turns "every remaining step failed" into
      // "the run was stopped after step N", which is the difference between a
      // report that reads as a broken focus graph and one that reads as a human
      // deciding to take over.
      if (automationStopped()) {
        stoppedMidRun = true;
        break;
      }

      const step = steps[i];
      const label = step.label ?? `step ${i + 1}`;

      const r = await assertFocusMove({
        press: step.press,
        expect: step.expect,
        holdMs: step.holdMs,
        settleTimeoutMs: step.settleTimeoutMs,
        port: opts.port,
        // The whole point: reuse the run's tunnel instead of opening one per press.
        cdpUrl: cdpBase,
      });

      // assertFocusMove re-reads focus before its press rather than trusting the
      // previous step's "after". That costs a read per step and is worth it: if
      // anything async moved the ring between steps, a cached value would hide it.
      const after: ReadFocusResult | null = r.after;
      const pass = r.ok && (step.expect ? r.matched === true : true);

      results.push({
        index: i + 1,
        label,
        press: r.press,
        expect: r.expect,
        ok: r.ok,
        pass,
        moved: r.moved,
        matched: r.matched,
        from: describe(r.before),
        to: describe(after),
        focusKey: focusKey(after),
        settled: r.settled,
        settleMs: r.settleMs,
        diagnosis: r.diagnosis,
        reason: r.reason,
      });

      if (r.ok) {
        visits.push({
          step: i + 1,
          key: focusKey(after),
          label: describe(after),
          el: after?.gpfocus ?? null,
        });
      }

      if (!pass && stopOnFailure) break;
    }
  } finally {
    closeTunnel?.();
  }

  const passed = results.filter((r) => r.pass).length;
  const failed = results.length - passed;
  const cycle = findCycle(visits);

  const seenLabels: string[] = [];
  for (const v of visits) if (!seenLabels.includes(v.label)) seenLabels.push(v.label);

  const neverReached = mustReach.filter((t) => !visits.some((v) => matchesText(v.el, t)));

  const ranAll = results.length === steps.length;
  // A stopped run is never "ok" -- it did not do what it was asked -- but the
  // reason is a person, not the plugin.
  const ok = failed === 0 && ranAll && !stoppedMidRun;

  const parts = [
    stoppedMidRun
      ? `KILLSWITCH: the run was stopped by hand after ${results.length}/${steps.length} step(s); ` +
        `the remaining ${steps.length - results.length} were never attempted`
      : null,
    `${passed}/${steps.length} steps passed`,
    ranAll || stoppedMidRun ? null : `stopped after ${results.length}`,
    cycle
      ? `focus returned to ${cycle.key.startsWith("sel:") ? cycle.loop[0] : cycle.loop[0]} ` +
        `at steps ${cycle.seenAt.join(" and ")}` +
        (cycle.stepsAfterLoop === 0
          ? " (the run ended there, so whether the ring could have escaped is untested)"
          : cycle.escaped
            ? " and escaped afterwards"
            : ` and never reached anything new in the ${cycle.stepsAfterLoop} step(s) after`)
      : null,
    neverReached.length ? `never reached: ${neverReached.join(", ")}` : null,
  ].filter(Boolean);

  const result: RunSequenceResult = {
    ok,
    reason: stoppedMidRun ? stoppedMessage(automationStopped() ?? latchedBefore!) : undefined,
    fidelity: results.some((r) => r.ok) ? "steam-routed" : null,
    steps: results,
    ranSteps: results.length,
    totalSteps: steps.length,
    passed,
    failed,
    visited: seenLabels,
    cycle,
    neverReached,
    stopped: stoppedMidRun,
    evidenceFile: null,
    durationMs: Date.now() - started,
    acquired,
    summary: parts.join("; "),
  };

  if (opts.writeEvidence !== false) {
    try {
      const dir = getWorkspaceArtifactsDir("runs");
      const name = (opts.runName ?? `run_${timestamp()}`).replace(/[^A-Za-z0-9._-]/g, "_");
      const file = path.join(dir, `${name}.json`);
      fs.writeFileSync(file, JSON.stringify(result, null, 2), "utf8");
      result.evidenceFile = file;
    } catch (err) {
      // A run that produced findings must not be thrown away because the log
      // could not be written. Say so and hand back the findings anyway.
      result.summary += `; evidence file could not be written (${(err as Error).message})`;
    }
  }

  return result;
}

/** Exported for tests and for openPlugin, which builds its own visit list. */
export { findCycle, describeElement };

/**
 * deck.sweep -- free play, scripted. Emulate a user D-padding around a pane
 * and record what they would have found at every stop.
 *
 * Plan 06, 2026-08-31. The maintainer found the dock bug by "just using the
 * thing": scroll around, walk down, try the buttons -- and every automated check
 * had passed, because each one answered a question it was asked and nobody had
 * asked "can a person see this". The sweep asks nothing in particular. It walks
 * a direction until the ring stops moving or comes back to somewhere it has
 * been, walks back, optionally repeats per carousel lane, and at EVERY stop
 * writes down what the tools now know how to measure: label, selector, rect,
 * where the pane was scrolled to, and the visibility verdict.
 *
 * SAFETY MODEL IS deck_walkTo's. It sends direction presses (and, for lanes,
 * LB/RB) and nothing else -- never A, B or START -- so a sweep cannot activate
 * a control, launch a game or leave the screen it started on. The refusal is
 * at input validation, before a tunnel is opened.
 *
 * THE REPORT IS FOR DIFFING. For a given UI state the rows and totals are
 * deterministic -- nothing in the evidence file depends on the clock -- so a
 * consumer commits one as a baseline and QA becomes "sweep, then diff". A new
 * stop, a lost stop, a stop that went from visible to covered: each is a diff
 * line, with no assertion authored per control. The first sweep after
 * bonsAI's dock shipped would have read `stopsFocusedButNotVisible: 3`.
 *
 * Built on runSequence's internals rather than beside them: one tunnel for the
 * whole run, assertFocusMove per press (so settle polling and moved detection
 * are the same as every other tool's), findCycle per leg, the same evidence
 * directory. No retries, for the same reason runSequence has none.
 */
import fs from "fs";
import path from "path";

import { openCdpTunnel } from "./cdpTunnel.js";
import { readFocusAt, ReadFocusResult, Visibility } from "./readFocus.js";
import { assertFocusMove } from "./assertFocusMove.js";
import { focusKey, describeVisibility, labelOfElement } from "./focusKey.js";
import { automationStopped, stoppedMessage } from "./killswitch.js";
import { acquireFocusIfUnowned, WalkDirection } from "./walkTo.js";
import { findCycle, CycleReport, Visit } from "./runSequence.js";
import { pressButton } from "./pressButton.js";
import { getWorkspaceArtifactsDir, timestamp } from "../tools/captureOrchestrator.js";

export type LaneButton = "LB" | "RB";

const DIRECTIONS: WalkDirection[] = ["UP", "DOWN", "LEFT", "RIGHT"];
const LANE_BUTTONS: LaneButton[] = ["LB", "RB"];
const OPPOSITE: Record<WalkDirection, WalkDirection> = {
  UP: "DOWN",
  DOWN: "UP",
  LEFT: "RIGHT",
  RIGHT: "LEFT",
};

export interface SweepOptions {
  /** Primary walk direction. Default DOWN. */
  direction?: WalkDirection;
  /** Walk back the opposite way after the primary leg ends. Default true. */
  returnTrip?: boolean;
  /**
   * How many extra carousel positions to repeat the walk in, reached by
   * pressing `laneButton` between them. Default 0: one lane, no shoulder press.
   */
  lanes?: number;
  /** LB or RB. Default RB. Nothing else is accepted. */
  laneButton?: LaneButton;
  /** Total press budget for the whole sweep, lane presses included. Default 80. */
  budget?: number;
  /** A leg ends after this many presses that do not move the ring. Default 2. */
  stallLimit?: number;
  /** As for deck_walkTo. Default true. */
  acquireFocus?: boolean;
  port?: string;
  cdpUrl?: string;
  /** Name for the evidence file. Defaults to sweep_<timestamp>. */
  runName?: string;
  /** Set false to skip writing an evidence file. Default true. */
  writeEvidence?: boolean;
  /** Test-only seam, as in runSequence: substitutes the press that places an unowned ring. */
  acquirePressFn?: typeof pressButton;
}

/** One row of the report: the ring at rest, and everything measured there. */
export interface SweepStop {
  index: number;
  lane: number;
  /** Which leg produced this row: "start", a direction, or "lane:RB". */
  leg: string;
  /** The press that led here; null for the starting read. */
  press: string | null;
  tag: string | null;
  label: string;
  labelSource: string | null;
  selector: string | null;
  rect: { x: number; y: number; w: number; h: number } | null;
  /** scrollTop of the pane the control sits in, or null when it is in none. */
  scrollTop: number | null;
  visibility: Visibility | null;
  focusKey: string | null;
}

export type LegEnd =
  | "stall"
  | "cycle"
  | "budget"
  | "press-failed"
  | "focus-unreadable"
  | "stopped";

export interface SweepLeg {
  lane: number;
  direction: string;
  presses: number;
  /** Rows this leg added (moves only; a press that moved nothing adds no row). */
  stops: number;
  endedBy: LegEnd;
  cycle: CycleReport | null;
}

export interface SweepTotals {
  /** Rows in the report, the starting read included. */
  stopsRecorded: number;
  /** Distinct controls the ring rested on. */
  stopsVisited: number;
  /** Distinct controls the rig could not name. */
  unlabeledStops: number;
  cycles: number;
  /** Rows where the ring was on a control a person could not see. */
  stopsFocusedButNotVisible: number;
  presses: number;
  legs: number;
}

export interface NotVisibleStop {
  index: number;
  lane: number;
  leg: string;
  label: string;
  verdict: Visibility["verdict"];
  visiblePercent: number;
  coveredBy: string | null;
  clippedBy: string | null;
}

/** The evidence file, exactly. Nothing in here depends on the clock. */
export interface SweepReport {
  tool: "deck_sweep";
  pattern: {
    direction: WalkDirection;
    returnTrip: boolean;
    lanes: number;
    laneButton: LaneButton;
    budget: number;
    stallLimit: number;
  };
  ok: boolean;
  reason?: string;
  stopped: boolean;
  totals: SweepTotals;
  notVisible: NotVisibleStop[];
  legs: SweepLeg[];
  stops: SweepStop[];
}

export interface SweepResult extends SweepReport {
  fidelity: "steam-routed" | null;
  acquired: boolean;
  evidenceFile: string | null;
  durationMs: number;
  /**
   * Presses that needed a second attempt because the serial port was busy
   * (pressButton.portBusy). In the result, not the report: it is a fact about
   * the host's serial port, not about the pane, and it would dirty a diff.
   */
  pressRetries: number;
  summary: string;
}

function stopFrom(
  index: number,
  lane: number,
  leg: string,
  press: string | null,
  f: ReadFocusResult,
): SweepStop {
  const el = f.gpfocus;
  return {
    index,
    lane,
    leg,
    press,
    tag: el?.tag ?? null,
    label: labelOfElement(el),
    labelSource: el?.labelSource ?? null,
    selector: el?.selector ?? null,
    rect: el?.rect ?? null,
    scrollTop: f.scrollPane?.scrollTop ?? null,
    visibility: f.visibility ?? null,
    focusKey: focusKey(f),
  };
}

function visitOf(stop: SweepStop): Visit {
  return {
    step: stop.index,
    key: stop.focusKey,
    label: stop.label || `<${stop.tag ?? "?"}>`,
    el: null,
    visibility: stop.visibility,
  };
}

/**
 * The diffable half of the report, from the rows. Pure, and exported so the
 * shape can be pinned without a Deck.
 */
export function summarize(
  stops: SweepStop[],
  legs: SweepLeg[],
  presses: number,
): { totals: SweepTotals; notVisible: NotVisibleStop[] } {
  const keys = new Map<string, SweepStop>();
  for (const s of stops) {
    const k = s.focusKey ?? `row:${s.index}`;
    if (!keys.has(k)) keys.set(k, s);
  }
  const notVisible: NotVisibleStop[] = stops
    .filter((s) => s.visibility && s.visibility.verdict !== "visible")
    .map((s) => ({
      index: s.index,
      lane: s.lane,
      leg: s.leg,
      label: s.label,
      verdict: s.visibility!.verdict,
      visiblePercent: s.visibility!.visiblePercent,
      coveredBy: s.visibility!.coveredBy,
      clippedBy: s.visibility!.clippedBy,
    }));
  return {
    totals: {
      stopsRecorded: stops.length,
      stopsVisited: keys.size,
      unlabeledStops: [...keys.values()].filter((s) => !s.label).length,
      cycles: legs.filter((l) => l.cycle).length,
      stopsFocusedButNotVisible: notVisible.length,
      presses,
      legs: legs.length,
    },
    notVisible,
  };
}

export async function sweep(opts: SweepOptions = {}): Promise<SweepResult> {
  const started = Date.now();
  const direction = (opts.direction ?? "DOWN").toString().toUpperCase() as WalkDirection;
  const laneButton = (opts.laneButton ?? "RB").toString().toUpperCase() as LaneButton;
  const returnTrip = opts.returnTrip !== false;
  const lanes = Math.max(0, Math.floor(opts.lanes ?? 0));
  const budget = opts.budget ?? 80;
  const stallLimit = opts.stallLimit ?? 2;

  const pattern = { direction, returnTrip, lanes, laneButton, budget, stallLimit };
  const stops: SweepStop[] = [];
  const legs: SweepLeg[] = [];
  let presses = 0;
  let pressRetries = 0;
  let acquired = false;

  const finish = (
    ok: boolean,
    extra: { reason?: string; stopped?: boolean; summary: string },
  ): SweepResult => {
    const { totals, notVisible } = summarize(stops, legs, presses);
    const report: SweepReport = {
      tool: "deck_sweep",
      pattern,
      ok,
      reason: extra.reason,
      stopped: extra.stopped ?? false,
      totals,
      notVisible,
      legs,
      stops,
    };
    const result: SweepResult = {
      ...report,
      fidelity: presses > 0 ? "steam-routed" : null,
      acquired,
      evidenceFile: null,
      durationMs: Date.now() - started,
      pressRetries,
      summary:
        extra.summary +
        (pressRetries ? `; ${pressRetries} press(es) needed a retry because the serial port was busy` : ""),
    };
    if (opts.writeEvidence !== false && stops.length > 0) {
      try {
        const dir = getWorkspaceArtifactsDir("runs");
        const name = (opts.runName ?? `sweep_${timestamp()}`).replace(/[^A-Za-z0-9._-]/g, "_");
        const file = path.join(dir, `${name}.json`);
        // The report, not the result: durationMs and the file's own path would
        // make every diff against a baseline dirty.
        fs.writeFileSync(file, JSON.stringify(report, null, 2) + "\n", "utf8");
        result.evidenceFile = file;
      } catch (err) {
        result.summary += `; evidence file could not be written (${(err as Error).message})`;
      }
    }
    return result;
  };

  if (!DIRECTIONS.includes(direction)) {
    return finish(false, {
      reason:
        `sweep only moves the ring: direction must be one of ${DIRECTIONS.join(", ")}. ` +
        "A, B and START are refused here because a sweep must not be able to activate anything.",
      summary: "refused: not a direction",
    });
  }
  if (!LANE_BUTTONS.includes(laneButton)) {
    return finish(false, {
      reason:
        "laneButton must be LB or RB, which only change the carousel position. " +
        "Anything else could activate a control, and a sweep must not be able to.",
      summary: "refused: not a lane button",
    });
  }

  const latched = automationStopped();
  if (latched) {
    return finish(false, {
      stopped: true,
      reason: stoppedMessage(latched),
      summary: "refused: Deck automation is stopped, so nothing was pressed",
    });
  }

  let cdpBase = opts.cdpUrl;
  let closeTunnel: (() => void) | null = null;
  if (!cdpBase) {
    try {
      const tunnel = await openCdpTunnel();
      cdpBase = tunnel.base;
      closeTunnel = tunnel.close;
    } catch (err) {
      return finish(false, {
        reason: (err as Error).message,
        summary: "could not reach the Deck, so nothing was pressed",
      });
    }
  }

  try {
    let focus = await readFocusAt(cdpBase, 10_000);
    if (opts.acquireFocus !== false) {
      const outcome = await acquireFocusIfUnowned(focus, {
        cdpBase,
        direction,
        port: opts.port,
        pressFn: opts.acquirePressFn,
      });
      focus = outcome.focus;
      acquired = outcome.acquired;
      presses += outcome.presses;
    }
    if (!focus.ok) {
      return finish(false, {
        reason: focus.reason,
        summary: acquired
          ? `spent one press trying to place an unowned ring and focus is still unreadable: ${focus.reason ?? ""}`
          : "could not read focus before the sweep started, so nothing was pressed. " +
            "If the ring is unowned -- which it is right after a plugin opens -- one press " +
            "places it; acquireFocus does that automatically and is on by default.",
      });
    }

    stops.push(stopFrom(0, 0, "start", null, focus));

    let ranOut = false;

    /**
     * One press, one row if it moved. Returns why the leg (and, for anything
     * but a stall, a cycle or the budget, the whole sweep) has to end, or null
     * to go on.
     */
    const pressOnce = async (
      button: string,
      lane: number,
      leg: string,
    ): Promise<{ end: LegEnd | null; moved: boolean; reason?: string }> => {
      const mid = automationStopped();
      if (mid) return { end: "stopped", moved: false, reason: stoppedMessage(mid) };
      if (presses >= budget) {
        ranOut = true;
        return { end: "budget", moved: false };
      }

      const r = await assertFocusMove({ press: button, port: opts.port, cdpUrl: cdpBase });
      if (!r.ok) {
        // Focus readable and the press is what failed, or focus unreadable in
        // the first place -- the two send a reader to different places.
        return {
          end: r.before?.ok ? "press-failed" : "focus-unreadable",
          moved: false,
          reason: r.reason ?? r.diagnosis,
        };
      }
      presses++;
      if (r.pressRetried) pressRetries++;
      if (r.moved && r.after) {
        stops.push(stopFrom(stops.length, lane, leg, button, r.after));
      }
      return { end: null, moved: r.moved };
    };

    let fatal: { reason?: string; stopped: boolean } | null = null;

    for (let lane = 0; lane <= lanes && !fatal && !ranOut; lane++) {
      if (lane > 0) {
        const p = await pressOnce(laneButton, lane, `lane:${laneButton}`);
        if (p.end === "budget") break;
        if (p.end) {
          fatal = { reason: p.reason, stopped: p.end === "stopped" };
          break;
        }
      }

      const legDirections: WalkDirection[] = returnTrip
        ? [direction, OPPOSITE[direction]]
        : [direction];

      for (const dir of legDirections) {
        const leg: SweepLeg = {
          lane,
          direction: dir,
          presses: 0,
          stops: 0,
          endedBy: "stall",
          cycle: null,
        };
        const legVisits: Visit[] = [visitOf(stops[stops.length - 1])];
        const seenKeys = new Set<string | null>([legVisits[0].key]);
        let stalls = 0;

        for (;;) {
          const p = await pressOnce(dir, lane, dir);
          if (p.end) {
            leg.endedBy = p.end;
            if (p.end !== "budget") fatal = { reason: p.reason, stopped: p.end === "stopped" };
            break;
          }
          leg.presses++;
          if (!p.moved) {
            stalls++;
            if (stalls >= stallLimit) {
              leg.endedBy = "stall";
              break;
            }
            continue;
          }
          stalls = 0;
          leg.stops++;
          const stop = stops[stops.length - 1];
          legVisits.push(visitOf(stop));
          // Back somewhere this leg has already been: the pane wraps, or the
          // ring is trapped. Either way the leg has shown everything it can.
          if (seenKeys.has(stop.focusKey)) {
            leg.endedBy = "cycle";
            break;
          }
          seenKeys.add(stop.focusKey);
        }

        leg.cycle = findCycle(legVisits);
        legs.push(leg);
        if (fatal || ranOut) break;
      }
    }

    const { totals, notVisible } = summarize(stops, legs, presses);
    const shout = notVisible.length
      ? `; ${notVisible.length} stop(s) FOCUSED BUT NOT VISIBLE: ` +
        notVisible
          .map(
            (n) =>
              `#${n.index} ${n.label || "<unnamed>"} ${describeVisibility(stops[n.index].visibility)}`,
          )
          .join("; ")
      : "; every stop was visible";

    const summary =
      (fatal
        ? fatal.stopped
          ? `KILLSWITCH: the sweep was stopped by hand after ${presses} press(es)`
          : `the sweep ended early after ${presses} press(es): ${fatal.reason ?? "unknown"}`
        : `swept ${totals.stopsVisited} control(s) in ${presses} press(es) over ${legs.length} leg(s)` +
          (ranOut ? ` and ran out of budget (${budget}) before the pattern finished` : "")) +
      (totals.unlabeledStops ? `; ${totals.unlabeledStops} unnamed` : "") +
      (totals.cycles ? `; ${totals.cycles} leg(s) cycled` : "") +
      shout;

    return finish(!fatal && !ranOut, {
      reason:
        fatal?.reason ??
        (ranOut ? `press budget of ${budget} exhausted before the pattern finished` : undefined),
      stopped: fatal?.stopped ?? false,
      summary,
    });
  } finally {
    closeTunnel?.();
  }
}

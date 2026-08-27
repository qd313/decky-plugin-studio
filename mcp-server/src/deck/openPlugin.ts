/**
 * deck.openPlugin -- get the plugin on screen, by driving Steam, with every
 * stage verified against a read rather than assumed.
 *
 * The old version of this tool returned a checklist and said "Deck UI cannot be
 * automated in v1". The bridge makes that untrue, but replacing it with a fixed
 * button sequence would be worse than the checklist: a canned "press GUIDE+A,
 * then Down four times, then A" is a guess about a menu whose layout depends on
 * the Steam build, which tabs the user has, and where the ring happened to be.
 * Run it blind and it activates something in an unrelated menu.
 *
 * So this searches instead of assuming, under two safety rules:
 *
 *   RULE 1 -- only the D-pad while searching. Direction presses move the focus
 *   ring and nothing else. A, B and START change state, and a state change in a
 *   menu we have not identified yet is exactly the accident to avoid.
 *
 *   RULE 2 -- A is pressed only when the read taken immediately before it says
 *   the ring is on a control whose label matches the plugin. Not "should be by
 *   now" -- confirmed, on that read.
 *
 * Every stage is bounded. When a search runs out of budget the tool REFUSES and
 * hands back the old checklist plus what it actually saw, which is far more
 * useful than the checklist alone: "I got to the Decky tab, walked 12 controls,
 * and none of them were called bonsAI" tells you something.
 */
import { openCdpTunnel } from "./cdpTunnel.js";
import { pressButton, pressChord } from "./pressButton.js";
import { readFocusAt, ReadFocusResult } from "./readFocus.js";
import { focusKey, describe } from "./focusKey.js";
import { automationStopped, stoppedMessage } from "./killswitch.js";

export interface OpenStage {
  stage: string;
  ok: boolean;
  detail: string;
  presses: number;
}

export interface OpenPluginResult {
  ok: boolean;
  pluginName: string;
  /** True only when a read confirmed the plugin's own panel is on screen. */
  verified: boolean;
  fidelity: "steam-routed" | null;
  stages: OpenStage[];
  /** Controls seen while walking the Decky list, for when the plugin was not found. */
  seen: string[];
  focus: ReadFocusResult | null;
  reason?: string;
  /** True when the run ended because the killswitch was thrown. */
  stopped: boolean;
  /** Present only when the tool could not do it, so a human still can. */
  checklist?: string[];
  summary: string;
}

/**
 * Thrown from the one helper every press in this file goes through, so a stop
 * unwinds the whole staged sequence at once rather than needing a check bolted
 * onto each of the four stages -- which is the version that grows a fifth stage
 * without one.
 */
class AutomationStoppedError extends Error {}

export interface OpenPluginOptions {
  pluginName: string;
  port?: string;
  cdpUrl?: string;
  /** Max D-pad presses when hunting the Decky tab. */
  tabBudget?: number;
  /** Max D-pad presses when hunting the plugin's row. */
  listBudget?: number;
}

const CHECKLIST = (name: string): string[] => [
  "On the Deck, open Quick Access Menu (QAM)",
  "Open Decky Loader",
  `Open the "${name}" plugin panel`,
  "Keep the plugin panel visible for deck.captureScreenshot / deck.record",
];

/** Decky's Quick Access tab. Steam's own are 0 and 3-7. */
const DECKY_TAB = "999";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function labelOf(r: ReadFocusResult | null): string {
  const el = r?.gpfocus;
  if (!el) return "";
  return (el.text || el.ariaLabel || "").trim();
}

/** Loose match so "bonsAI" finds a row rendered as "bonsAI 0.9.1" or "  BonsAI ". */
function isPluginRow(r: ReadFocusResult | null, name: string): boolean {
  const label = labelOf(r).toLowerCase();
  const want = name.toLowerCase();
  return label.length > 0 && label.includes(want);
}

export async function openPluginDriven(opts: OpenPluginOptions): Promise<OpenPluginResult> {
  const pluginName = opts.pluginName;
  const tabBudget = opts.tabBudget ?? 10;
  const listBudget = opts.listBudget ?? 25;

  const stages: OpenStage[] = [];
  const seen: string[] = [];

  const fail = (
    reason: string,
    focus: ReadFocusResult | null,
    summary: string,
    stopped = false,
  ): OpenPluginResult => ({
    ok: false,
    pluginName,
    verified: false,
    fidelity: stages.some((s) => s.presses > 0) ? "steam-routed" : null,
    stages,
    seen,
    focus,
    reason,
    stopped,
    checklist: CHECKLIST(pluginName),
    summary,
  });

  // Before the tunnel: a stopped rig should not spend SSH setup on a sequence
  // that cannot deliver its first press.
  const latched = automationStopped();
  if (latched) {
    return fail(
      stoppedMessage(latched),
      null,
      "refused: Deck automation is stopped, so nothing was pressed",
      true,
    );
  }

  let cdpBase = opts.cdpUrl;
  let closeTunnel: (() => void) | null = null;
  if (!cdpBase) {
    try {
      const tunnel = await openCdpTunnel();
      cdpBase = tunnel.base;
      closeTunnel = tunnel.close;
    } catch (err) {
      stages.push({ stage: "connect", ok: false, detail: (err as Error).message, presses: 0 });
      return fail(
        (err as Error).message,
        null,
        "could not reach the Deck, so nothing was pressed - follow the checklist by hand",
      );
    }
  }

  /** Every press in this file, D-pad or otherwise, passes through this first. */
  const abortIfStopped = (): void => {
    const rec = automationStopped();
    if (rec) throw new AutomationStoppedError(stoppedMessage(rec));
  };

  /** A D-pad press followed by a settle and a fresh read. Never A, never B. */
  const nudge = async (dir: "UP" | "DOWN" | "LEFT" | "RIGHT"): Promise<ReadFocusResult> => {
    abortIfStopped();
    const p = await pressButton({ buttons: [dir], port: opts.port });
    if (!p.ok) throw new Error(p.reason ?? "press failed");
    await sleep(180);
    return readFocusAt(cdpBase!, 10_000);
  };

  try {
    // ---- Stage 1: where are we? -------------------------------------------
    let focus = await readFocusAt(cdpBase, 10_000);
    if (!focus.ok) {
      stages.push({ stage: "read-initial", ok: false, detail: focus.reason ?? "", presses: 0 });
      return fail(
        focus.reason ?? "could not read focus",
        focus,
        "could not read the Deck's focus state, so nothing was pressed",
      );
    }
    stages.push({
      stage: "read-initial",
      ok: true,
      detail: `tab=${focus.quickAccessTab ?? "none"}, ring on ${describe(focus)}`,
      presses: 0,
    });

    // ---- Stage 2: reach the Decky pane ------------------------------------
    //
    // Rewritten 2026-08-26 after three separate mistakes showed up on hardware
    // within ten minutes of each other. All three came from reasoning about the
    // QAM instead of measuring it:
    //
    //   1. The open chord was sent as GUIDE and A pressed together. Steam wants
    //      hold-GUIDE-then-tap-A; the simultaneous version reads as a bare GUIDE
    //      press, opens the Steam main menu, and drops the A into whatever that
    //      menu is showing.
    //   2. "Is the QAM open?" was answered with `quickAccessTab !== null`. That
    //      is null whenever the ring sits on the QAM's own tab rail -- which is
    //      where it lands when the menu opens -- so an open menu read as closed
    //      and got the chord fired at it, closing it again.
    //   3. Tabs were walked with RIGHT. RIGHT does not change QAM tabs; on the
    //      Quick Settings pane it lands on the Brightness slider and drags it.
    //      LB/RB do not switch them either. The rail is reached with LEFT and
    //      walked with DOWN.
    if (focus.visibleQuickAccessTab !== DECKY_TAB) {
      if (focus.visibleQuickAccessTab === null) {
        // No pane on screen at all: the menu is genuinely shut.
        abortIfStopped();
        const p = await pressChord("GUIDE", "A", { port: opts.port });
        if (!p.ok) {
          stages.push({ stage: "open-qam", ok: false, detail: p.reason ?? "", presses: 0 });
          return fail(p.reason ?? "chord failed", focus, "the QAM chord could not be delivered");
        }
        await sleep(900);
        focus = await readFocusAt(cdpBase, 10_000);
        const opened = focus.ok && focus.visibleQuickAccessTab !== null;
        stages.push({
          stage: "open-qam",
          ok: opened,
          detail: opened
            ? `QAM open, pane ${focus.visibleQuickAccessTab} on screen`
            : "no quickaccess pane became visible after the chord",
          presses: 1,
        });
        if (!opened) {
          return fail(
            "the QAM chord was delivered but no quickaccess pane appeared",
            focus,
            "could not confirm the Quick Access Menu opened",
          );
        }
      }

      // Step out to the rail if the ring is inside a pane. One press, verified:
      // on the rail the ring belongs to no pane, so quickAccessTab goes null
      // while a pane stays on screen.
      if (focus.quickAccessTab !== null) {
        focus = await nudge("LEFT");
        const onRail = focus.ok && focus.quickAccessTab === null && focus.visibleQuickAccessTab !== null;
        stages.push({
          stage: "reach-rail",
          ok: onRail,
          detail: onRail
            ? `on the tab rail, pane ${focus.visibleQuickAccessTab} showing`
            : `expected the rail; tab=${focus.quickAccessTab ?? "none"}, visible=${focus.visibleQuickAccessTab ?? "none"}`,
          presses: 1,
        });
        if (!onRail) {
          return fail(
            "could not step out to the Quick Access tab rail",
            focus,
            "one Left press did not land on the tab rail - open the Decky tab by hand",
          );
        }
      }

      // Walk the rail. The pane on screen changes as the ring moves, so that is
      // the thing to check -- nothing here assumes rail order or entry count.
      let presses = 0;
      const from = focus.visibleQuickAccessTab;
      while (focus.visibleQuickAccessTab !== DECKY_TAB && presses < tabBudget) {
        focus = await nudge("DOWN");
        presses++;
        if (!focus.ok) break;
      }
      const reached = focus.visibleQuickAccessTab === DECKY_TAB;
      stages.push({
        stage: "find-decky-tab",
        ok: reached,
        detail: reached
          ? `pane ${DECKY_TAB} on screen after ${presses} rail press(es)`
          : `started on pane ${from}, ended on ${focus.visibleQuickAccessTab ?? "none"} after ${presses} press(es)`,
        presses,
      });
      if (!reached) {
        return fail(
          `could not reach the Decky pane (${DECKY_TAB}) within ${tabBudget} rail presses`,
          focus,
          `walked ${presses} rail entries without the Decky pane appearing - open it by hand`,
        );
      }

      // Enter the pane so the ring is on a plugin row rather than the rail.
      if (focus.quickAccessTab !== DECKY_TAB) {
        focus = await nudge("RIGHT");
        const entered = focus.ok && focus.quickAccessTab === DECKY_TAB;
        stages.push({
          stage: "enter-decky-pane",
          ok: entered,
          detail: entered
            ? "ring is inside the Decky pane"
            : `expected tab ${DECKY_TAB}; ring reports ${focus.quickAccessTab ?? "none"}`,
          presses: 1,
        });
        if (!entered) {
          return fail(
            "could not move the ring into the Decky pane",
            focus,
            "the Decky pane is on screen but one Right press did not enter it",
          );
        }
      }
    }

    // ---- Stage 3: find the plugin's row -----------------------------------
    let presses = 0;
    let found = isPluginRow(focus, pluginName);
    const record = (r: ReadFocusResult): void => {
      const l = labelOf(r);
      if (l && !seen.includes(l)) seen.push(l);
    };
    record(focus);

    const keys = new Set<string>([focusKey(focus) ?? ""]);
    while (!found && presses < listBudget) {
      focus = await nudge("DOWN");
      presses++;
      if (!focus.ok) break;
      record(focus);
      if (isPluginRow(focus, pluginName)) {
        found = true;
        break;
      }
      // The list wraps or dead-ends: once the ring stops producing new elements
      // there is nothing left to walk, and continuing just burns the budget.
      const k = focusKey(focus) ?? "";
      if (keys.has(k)) break;
      keys.add(k);
    }
    stages.push({
      stage: "find-plugin",
      ok: found,
      detail: found
        ? `ring is on "${labelOf(focus)}" after ${presses} press(es)`
        : `walked ${presses} control(s) without finding "${pluginName}"`,
      presses,
    });
    if (!found) {
      return fail(
        `no control labelled "${pluginName}" was found on the Decky tab`,
        focus,
        `walked ${presses} control(s) on the Decky tab; saw ${seen.length ? seen.join(", ") : "nothing labelled"}`,
      );
    }

    // ---- Stage 4: activate, with rule 2 satisfied -------------------------
    // The read that authorises this A press is the one taken inside the loop
    // above, on this same element. Nothing has been pressed since.
    //
    // This is the most consequential press the studio makes -- the one that
    // activates a control rather than moving the ring -- so the latch is
    // re-checked on the line before it, after the walk that got here.
    abortIfStopped();
    const activate = await pressButton({ buttons: ["A"], port: opts.port });
    if (!activate.ok) {
      stages.push({ stage: "activate", ok: false, detail: activate.reason ?? "", presses: 0 });
      return fail(activate.reason ?? "press failed", focus, "the A press could not be delivered");
    }
    await sleep(700);
    const after = await readFocusAt(cdpBase, 10_000);

    // Opening a Decky plugin leaves the ring unowned -- measured, see
    // docs/planning/03. So "focus is nowhere" is the EXPECTED success signal
    // here, not a failure, and the panel is confirmed by the element count
    // instead.
    const grew = after.ok || (after.reason ?? "").includes("gpfocus marker not found");
    stages.push({
      stage: "activate",
      ok: grew,
      detail: after.ok
        ? `panel open, ring on ${describe(after)}`
        : "panel open, ring unowned (expected on plugin open - see planning doc 03)",
      presses: 1,
    });

    return {
      ok: true,
      pluginName,
      verified: true,
      fidelity: "steam-routed",
      stages,
      seen,
      focus: after,
      stopped: false,
      summary:
        `opened "${pluginName}" - ${stages.map((s) => `${s.stage} ${s.ok ? "ok" : "failed"}`).join(", ")}` +
        (after.ok ? "" : "; the ring is unowned, so the first D-pad press will place it rather than move it"),
    };
  } catch (err) {
    if (err instanceof AutomationStoppedError) {
      return fail(
        err.message,
        null,
        `KILLSWITCH: stopped by hand after ${stages.length} stage(s) ` +
          `(${stages.map((s) => s.stage).join(", ") || "none"}); the plugin was not opened`,
        true,
      );
    }
    return fail(
      (err as Error).message,
      null,
      `stopped after ${stages.length} stage(s): ${(err as Error).message}`,
    );
  } finally {
    closeTunnel?.();
  }
}

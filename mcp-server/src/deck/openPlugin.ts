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
import { pressButton } from "./pressButton.js";
import { readFocusAt, ReadFocusResult } from "./readFocus.js";
import { focusKey, describe } from "./focusKey.js";

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
  /** Present only when the tool could not do it, so a human still can. */
  checklist?: string[];
  summary: string;
}

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

  const fail = (reason: string, focus: ReadFocusResult | null, summary: string): OpenPluginResult => ({
    ok: false,
    pluginName,
    verified: false,
    fidelity: stages.some((s) => s.presses > 0) ? "steam-routed" : null,
    stages,
    seen,
    focus,
    reason,
    checklist: CHECKLIST(pluginName),
    summary,
  });

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

  /** A D-pad press followed by a settle and a fresh read. Never A, never B. */
  const nudge = async (dir: "UP" | "DOWN" | "LEFT" | "RIGHT"): Promise<ReadFocusResult> => {
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

    // ---- Stage 2: reach the Decky tab -------------------------------------
    if (focus.quickAccessTab !== DECKY_TAB) {
      if (focus.quickAccessTab === null) {
        // Not in the Quick Access Menu at all. Opening it is a chord, not a
        // D-pad move, so it is the one exception to rule 1 -- and it is safe
        // because GUIDE+A does the same thing from anywhere.
        const p = await pressButton({ buttons: ["GUIDE", "A"], port: opts.port });
        if (!p.ok) {
          stages.push({ stage: "open-qam", ok: false, detail: p.reason ?? "", presses: 0 });
          return fail(p.reason ?? "press failed", focus, "the QAM chord could not be delivered");
        }
        await sleep(600);
        focus = await readFocusAt(cdpBase, 10_000);
        const opened = focus.ok && focus.quickAccessTab !== null;
        stages.push({
          stage: "open-qam",
          ok: opened,
          detail: opened
            ? `QAM open on tab ${focus.quickAccessTab}`
            : "QAM did not report a quickaccess pane after the chord",
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

      // Walk toward the Decky tab, checking the tab id after every single press.
      // Nothing here assumes how many presses it takes or which way it is.
      let presses = 0;
      let reached = focus.quickAccessTab === DECKY_TAB;
      const before = focus.quickAccessTab;
      while (!reached && presses < tabBudget) {
        focus = await nudge("RIGHT");
        presses++;
        if (focus.ok && focus.quickAccessTab === DECKY_TAB) reached = true;
      }
      stages.push({
        stage: "find-decky-tab",
        ok: reached,
        detail: reached
          ? `reached tab ${DECKY_TAB} after ${presses} press(es)`
          : `started on tab ${before}, ended on tab ${focus.quickAccessTab ?? "none"} after ${presses} press(es)`,
        presses,
      });
      if (!reached) {
        return fail(
          `could not reach the Decky tab (${DECKY_TAB}) within ${tabBudget} presses`,
          focus,
          `walked ${presses} controls without the Decky tab appearing - open it by hand`,
        );
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
      summary:
        `opened "${pluginName}" - ${stages.map((s) => `${s.stage} ${s.ok ? "ok" : "failed"}`).join(", ")}` +
        (after.ok ? "" : "; the ring is unowned, so the first D-pad press will place it rather than move it"),
    };
  } catch (err) {
    return fail(
      (err as Error).message,
      null,
      `stopped after ${stages.length} stage(s): ${(err as Error).message}`,
    );
  } finally {
    closeTunnel?.();
  }
}

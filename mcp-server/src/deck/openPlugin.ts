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
import { focusKey, describe, labelIsBorrowed } from "./focusKey.js";
import { automationStopped, stoppedMessage } from "./killswitch.js";
import { acquireFocusIfUnowned } from "./walkTo.js";
import { readPage } from "./readPage.js";

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
  /**
   * True when the panel was already open and on screen before this call did
   * anything -- so `ok: true` here means "confirmed open", not "just opened".
   */
  alreadyOpen?: boolean;
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
  /**
   * CSS selector for an element the plugin's own panel renders, e.g.
   * ".bonsai-scope". When given, this decides whether the panel is open --
   * both ways -- instead of the label heuristic, and it is also what confirms
   * the panel actually mounted after the A press.
   *
   * Worth setting. Without it the tool infers from Decky's pane labels, which
   * is inference about someone else's markup; with it the plugin answers for
   * itself. Defaults to `panelRootSelector` in the workspace's
   * `.decky/preview.json`.
   */
  rootSelector?: string;
  /**
   * Test-only seam: substitutes every D-pad press, so the navigation ORDER can
   * be exercised without the bridge board. Production code never sets this and
   * always gets the real press.
   *
   * It earns its place because the suite's hardware guard refuses real presses,
   * so without it every navigation test collapses to the same "no press could
   * be delivered" outcome and cannot tell a tool that pressed RIGHT to enter the
   * Decky pane from one that pressed DOWN along the rail -- which is exactly the
   * distinction the 2026-08-28 rail bug turned on.
   */
  pressFn?: typeof pressButton;
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

/**
 * The focused control's OWN name, never a borrowed one.
 *
 * A row in the Decky list is identified by what the row itself is called. An
 * ancestor's text is the wrong evidence here in a way it is not for walkTo: a
 * control anywhere inside bonsAI's panel inherits "bonsAI" from the pane header
 * and would read as the plugin's list row, which is how an earlier version of
 * this tool came to press A on a suggestion chip.
 */
function labelOf(r: ReadFocusResult | null): string {
  const el = r?.gpfocus;
  if (!el) return "";
  if (labelIsBorrowed(el)) return "";
  if (el.label !== undefined) return el.label.trim();
  return (el.ariaLabel || el.text || "").trim();
}

/** Loose match so "bonsAI" finds a row rendered as "bonsAI 0.9.1" or "  BonsAI ". */
function isPluginRow(r: ReadFocusResult | null, name: string): boolean {
  const label = labelOf(r).toLowerCase();
  const want = name.toLowerCase();
  return label.length > 0 && label.includes(want);
}

/**
 * Decky's own pane title. The plugin LIST carries it; an open plugin's panel
 * replaces it with the plugin's name.
 */
const DECKY_LIST_LABEL = "decky";

/**
 * Is the ring sitting inside the REQUESTED plugin's own panel? Best effort from
 * labels alone -- see panelRootMounted() for the answer that does not guess.
 *
 * This check has now been wrong in both directions, one bug per direction, and
 * both are worth keeping in view because they pull against each other.
 *
 * FALSE NEGATIVE (fixed 2026-08-27). The first version asked whether the focused
 * control's text mentioned the plugin's name. That missed the real case -- the
 * ring lands on controls called "ask" or "Show diagnostics", which say nothing
 * about the plugin they belong to -- so the tool walked the list while standing
 * inside the panel, and pressed A on a suggestion chip reading "...how bonsai
 * trees are pruned", which contains "bonsai" and identifies nothing.
 *
 * FALSE POSITIVE (fixed 2026-08-28, P1-9, and it was the cost of that fix).
 * Matching a whole label in `deckyPanelLabels` looked airtight, on the belief
 * that the open plugin's name is rendered as a label and nothing else on the
 * page says which plugin is open. Both halves are true; the missing half is that
 * the plugin LIST also renders every installed plugin's name as a label of its
 * own. Three times in one session -- each after a `plugin_loader` restart, which
 * closes the panel -- the tool answered `alreadyOpen: true` from the label set
 * `["Decky", "bonsAI", "TabMaster", "MagicPods", ...]`, with the ring on a button
 * in the Decky pane HEADER and no bonsAI root in the document at all. It could
 * not tell "bonsAI's panel is open" from "bonsAI is a row in the list", which is
 * the exact distinction it was added to make.
 *
 * So the name being present is necessary and not sufficient: the list's own
 * title must also be absent. Residual risk, stated rather than hidden -- a
 * plugin that renders a short label reading exactly "Decky" falls back to
 * walking the list, which costs presses and ends in an honest checklist. That is
 * the failure to prefer.
 */
function looksLikeOpenPanelFor(r: ReadFocusResult | null, name: string): boolean {
  if (!r?.ok || !r.deckyPluginRoot) return false;
  const want = name.trim().toLowerCase();
  if (!want) return false;

  const labels = (r.deckyPanelLabels ?? []).map((label) => label.trim().toLowerCase());
  if (!labels.includes(want)) return false;
  // A plugin genuinely called "Decky" is named by the same label, so exclude the
  // requested name from this test rather than refusing that plugin outright.
  return !labels.some((label) => label === DECKY_LIST_LABEL && label !== want);
}

/**
 * Ask the page whether the plugin's own root element is mounted AND has a box.
 *
 * This is the signal that does not guess. Labels are inference about what Decky
 * happens to render; a selector the plugin itself puts on its root is the plugin
 * saying "I am here". Both directions are definitive, which is why it overrides
 * the label heuristic when a caller supplies one.
 *
 * The box check matters as much as the presence check: Steam keeps every Quick
 * Access pane mounted and gives the off-screen ones a zero rect, so
 * `querySelector` alone would report a panel behind another tab as open --
 * swapping one false positive for a subtler one.
 *
 * Returns null when the page could not be asked at all, so an unreachable CDP
 * endpoint falls back to the labels instead of reading as "not open".
 */
async function panelRootMounted(selector: string, cdpBase: string): Promise<boolean | null> {
  const expr =
    `(() => { try { var el = document.querySelector(${JSON.stringify(selector)}); ` +
    "if (!el) return false; var r = el.getBoundingClientRect(); " +
    "return r.width > 0 && r.height > 0; } catch (e) { return null; } })()";
  const r = await readPage<boolean | null>({ expression: expr, cdpUrl: cdpBase });
  if (!r.ok) return null;
  return typeof r.value === "boolean" ? r.value : null;
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

  const press = opts.pressFn ?? pressButton;

  /** A D-pad press followed by a settle and a fresh read. Never A, never B. */
  const nudge = async (dir: "UP" | "DOWN" | "LEFT" | "RIGHT"): Promise<ReadFocusResult> => {
    abortIfStopped();
    const p = await press({ buttons: [dir], port: opts.port });
    if (!p.ok) throw new Error(p.reason ?? "press failed");
    await sleep(180);
    return readFocusAt(cdpBase!, 10_000);
  };

  try {
    // ---- Stage 1: where are we? -------------------------------------------
    let focus = await readFocusAt(cdpBase, 10_000);

    /*
     * An unowned ring is where this tool is normally CALLED FROM, not an edge
     * case: nothing owns gamepad focus after a plugin opens or an Ask finishes,
     * which is exactly when someone reaches for deck_openPlugin. Refusing here
     * meant the already-open detection further down (stage 3) could never run
     * in the one situation it was written for -- the live pass on 2026-08-27
     * hit precisely that, with the panel plainly open on screen.
     *
     * Same mechanism walkTo and runSequence use, one D-pad press, which places
     * an unowned ring without activating anything.
     */
    let acquired = false;
    if (!focus.ok) {
      abortIfStopped();
      const outcome = await acquireFocusIfUnowned(focus, {
        cdpBase,
        direction: "DOWN",
        port: opts.port,
        pressFn: opts.pressFn,
      });
      focus = outcome.focus;
      acquired = outcome.acquired;
      if (acquired) {
        stages.push({
          stage: "acquire-focus",
          ok: focus.ok,
          detail: "nothing owned the ring, so one DOWN press placed it",
          presses: outcome.presses,
        });
      }
    }

    if (!focus.ok) {
      stages.push({ stage: "read-initial", ok: false, detail: focus.reason ?? "", presses: 0 });
      return fail(
        focus.reason ?? "could not read focus",
        focus,
        acquired
          ? "could not read the Deck's focus state even after placing the ring"
          : "could not read the Deck's focus state, so nothing was pressed",
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
    /*
     * EACH STEP KEYS ON ITS OWN PRECONDITION.
     *
     * All three used to sit under one `if (visibleQuickAccessTab !== DECKY_TAB)`
     * guard, which conflated "the right pane is showing" with "the ring is in
     * it". Those come apart in the single most common starting state there is:
     * right after a game launches, the Decky pane is on screen and the ring is
     * on the QAM's left rail. The whole block was skipped, the RIGHT press that
     * enters the pane along with it, and stage 3 then walked DOWN the RAIL --
     * giving up after 2 presses with "walked 2 control(s) without finding
     * bonsAI" (2, not the budget of 25, because rail icons repeat a focusKey
     * almost immediately). One press was all it needed, and it already existed.
     */

    // The menu is genuinely shut only when no pane has a box at all. Not
    // `quickAccessTab === null` -- that is also true on the rail, and reading it
    // as "closed" fired the open chord at an open menu and closed it again.
    if (focus.visibleQuickAccessTab === null) {
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

    // Wrong pane on screen: get to the rail, then walk it until Decky's shows.
    if (focus.visibleQuickAccessTab !== DECKY_TAB) {
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
      let railPresses = 0;
      const from = focus.visibleQuickAccessTab;
      while (focus.visibleQuickAccessTab !== DECKY_TAB && railPresses < tabBudget) {
        focus = await nudge("DOWN");
        railPresses++;
        if (!focus.ok) break;
      }
      const reached = focus.visibleQuickAccessTab === DECKY_TAB;
      stages.push({
        stage: "find-decky-tab",
        ok: reached,
        detail: reached
          ? `pane ${DECKY_TAB} on screen after ${railPresses} rail press(es)`
          : `started on pane ${from}, ended on ${focus.visibleQuickAccessTab ?? "none"} after ${railPresses} press(es)`,
        presses: railPresses,
      });
      if (!reached) {
        return fail(
          `could not reach the Decky pane (${DECKY_TAB}) within ${tabBudget} rail presses`,
          focus,
          `walked ${railPresses} rail entries without the Decky pane appearing - open it by hand`,
        );
      }
    }

    /*
     * The Decky pane is showing but the ring is not in it -- the rail case
     * above, and equally the state after the rail walk. Hoisted out of the
     * `visibleQuickAccessTab !== DECKY_TAB` guard on 2026-08-28: this press has
     * to run whenever the ring is outside the pane, not only when we were the
     * ones who changed the pane.
     */
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

    // ---- Stage 3: find the plugin's row -----------------------------------
    let presses = 0;

    /*
     * ALREADY-OPEN IS CHECKED FIRST, BEFORE isPluginRow.
     *
     * It used to be guarded by `!found`, and on the live rig that guard was
     * what defeated it. isPluginRow() asks whether the focused control's text
     * CONTAINS the plugin's name, which is a fine question about a row in the
     * Decky list and a bad one about anything else: inside the bonsAI panel the
     * ring sat on a suggestion chip reading "write a long detailed explanation
     * of how bonsai trees are pruned", isPluginRow said "that is the row", and
     * the tool pressed A on it. `found` was true, so the already-open check
     * never ran, in the exact state it was written for.
     *
     * Being inside the plugin's own panel is the stronger fact -- it is decided
     * by the panel header, not by whatever prose a control happens to carry --
     * so it is asked first and settles the question with no presses at all.
     */
    /*
     * The selector, when there is one, OVERRIDES the labels in both directions.
     * It is the plugin's own markup rather than an inference about Decky's, and
     * P1-9 was precisely a confident inference: the tool announced the panel was
     * open while `.bonsai-scope` was absent from the document, and the caller
     * then spent three read-and-navigate rounds acting on a panel that was not
     * there. A null here means the page could not be asked, which is not
     * evidence either way, so that falls back to the labels.
     */
    const rootSelector = (opts.rootSelector ?? "").trim();
    let rootMounted: boolean | null = null;
    if (rootSelector) {
      rootMounted = await panelRootMounted(rootSelector, cdpBase);
      stages.push({
        stage: "check-panel-root",
        ok: rootMounted !== null,
        detail:
          rootMounted === true
            ? `"${rootSelector}" is mounted and on screen, so the panel is genuinely open`
            : rootMounted === false
              ? `"${rootSelector}" is not in the document, so the panel is NOT open whatever the pane labels say`
              : `could not ask the page about "${rootSelector}"; falling back to the pane labels`,
        presses: 0,
      });
    }

    const alreadyOpen =
      rootMounted !== null ? rootMounted : looksLikeOpenPanelFor(focus, pluginName);

    if (alreadyOpen) {
      stages.push({
        stage: "already-open",
        ok: true,
        detail:
          `ring is already inside "${pluginName}"'s own panel (${describe(focus)}), not the Decky list` +
          (rootMounted === true ? `, confirmed by "${rootSelector}"` : ""),
        presses: 0,
      });
      return {
        ok: true,
        pluginName,
        verified: true,
        alreadyOpen: true,
        // Reached without the latch tripping -- the killswitch check above
        // returns early, so getting here means the rig was never stopped.
        stopped: false,
        fidelity: stages.some((s) => s.presses > 0) ? "steam-routed" : null,
        stages,
        seen,
        focus,
        summary:
          `"${pluginName}" was already open - ` +
          stages.map((s) => `${s.stage} ${s.ok ? "ok" : "failed"}`).join(", "),
      };
    }

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
    const activate = await press({ buttons: ["A"], port: opts.port });
    if (!activate.ok) {
      stages.push({ stage: "activate", ok: false, detail: activate.reason ?? "", presses: 0 });
      return fail(activate.reason ?? "press failed", focus, "the A press could not be delivered");
    }
    await sleep(700);
    const after = await readFocusAt(cdpBase, 10_000);

    /*
     * Opening a Decky plugin leaves the ring unowned -- measured, see
     * docs/planning/03. So "focus is nowhere" is the EXPECTED signal here rather
     * than a failure, which is also why it is such weak evidence that anything
     * opened: an unowned ring is what a press into nothing looks like too.
     *
     * With a root selector we can stop inferring and ask. That closes the other
     * half of P1-9: the tool reported success having never asked the Deck
     * whether the plugin actually came up.
     */
    const openedRoot = rootSelector ? await panelRootMounted(rootSelector, cdpBase) : null;
    if (openedRoot === false) {
      stages.push({
        stage: "activate",
        ok: false,
        detail: `pressed A on "${pluginName}" but "${rootSelector}" never appeared in the document`,
        presses: 1,
      });
      return fail(
        `A was pressed on a control labelled "${pluginName}" but the panel did not mount ` +
          `("${rootSelector}" is absent)`,
        after,
        `the A press landed but "${pluginName}"'s panel never rendered - the row may not have been the plugin's`,
      );
    }

    const grew = after.ok || (after.reason ?? "").includes("gpfocus marker not found");
    stages.push({
      stage: "activate",
      ok: openedRoot === true || grew,
      detail:
        openedRoot === true
          ? `panel open, confirmed by "${rootSelector}"`
          : after.ok
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

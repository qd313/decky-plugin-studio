/**
 * Tests for deck.launchGame / deck.exitGame.
 *
 * Everything here runs through the seams: a scripted Deck answers focus reads
 * and page reads, and records every press. That is the only honest way to test
 * these two verbs without a board, and it is also the right level -- what
 * matters is the ORDER of presses and reads: that A is never pressed without a
 * read naming the control just before it, that a second game is never
 * launched, that "Install" is refused where "Play" is expected, and that the
 * killswitch stops a run before its next press. The presses themselves, and
 * the labels Steam actually renders, are verified on a Deck (plan 07 § 6); the
 * fixtures below carry those measured labels and selectors.
 *
 * THE LATCH IS REDIRECTED TO A TEMP DIRECTORY, as in killswitch.test.ts: the
 * config dir derives from the home directory at call time, so pointing
 * USERPROFILE/HOME at a temp dir moves the latch with them. Otherwise a
 * developer's real latch would make every test here read as "stopped", and the
 * latch test would write into their real config.
 */
process.env.DPS_NO_BRIDGE ??= "1";

import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { ReadFocusResult, LabelSource } from "./readFocus.js";
import type { PressOptions, PressResult } from "./pressButton.js";
import type { ReadPageOptions, ReadPageResult } from "./readPage.js";
import type { RunningApp, LibraryApp, GameSessionOptions, ExitGameOptions, GameProcess } from "./gameSession.js";
import type { Machine } from "../machines.js";

const realHome = { USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME };
const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "dps-gamesession-"));
process.env.USERPROFILE = tempHome;
process.env.HOME = tempHome;

const { launchGame, exitGame, listGames, gridStep, checkGameProcesses, parseGameProcesses, resolveApp, refusalLabel, inMainMenu, ownLabelOf } =
  await import("./gameSession.js");
const { getLatchPath } = await import("./killswitch.js");

function assertSandboxed(): void {
  assert.ok(
    getLatchPath().startsWith(tempHome),
    `latch path escaped the sandbox: ${getLatchPath()} is not under ${tempHome}`,
  );
}

before(() => assertSandboxed());
beforeEach(() => {
  assertSandboxed();
  fs.rmSync(getLatchPath(), { force: true });
});
after(() => {
  process.env.USERPROFILE = realHome.USERPROFILE;
  process.env.HOME = realHome.HOME;
  fs.rmSync(tempHome, { recursive: true, force: true });
});

// --------------------------------------------------------------------------
// Fixtures: the maintainer's Deck, as measured 2026-09-02
// --------------------------------------------------------------------------

const HL2: RunningApp = { appid: 220, display_name: "Half-Life 2" };
const DRG: RunningApp = { appid: 2321470, display_name: "Deep Rock Galactic: Survivor" };
const BROTATO: RunningApp = { appid: 1942280, display_name: "Brotato" };

const LIBRARY: LibraryApp[] = [
  { ...DRG, installed: true },
  { ...HL2, installed: true },
  { ...BROTATO, installed: true },
  { appid: 70, display_name: "Half-Life", installed: true },
  { appid: 546560, display_name: "Half-Life: Alyx", installed: false },
  // Two non-Steam shortcuts with the same name, exactly as allApps listed them.
  { appid: 4000000001, display_name: "007 - GoldenEye", installed: true },
  { appid: 4000000002, display_name: "007 - GoldenEye", installed: true },
];

const PANEL_ROWS = [
  "Resume game",
  "Controller settings",
  "View game details",
  "Achievements",
  "Guides",
  "Notes",
  "Game Recording",
  "Exit game",
];

function ring(
  label: string,
  o: {
    selector?: string;
    tag?: string;
    target?: string;
    source?: LabelSource;
    qam?: string | null;
    within?: string[];
  } = {},
): ReadFocusResult {
  const selector = o.selector ?? null;
  return {
    ok: true,
    fidelity: "steam-owned",
    method: "cdp:fake",
    target: { title: o.target ?? "Steam Big Picture Mode", url: "" },
    steamBuild: null,
    gpfocus: {
      selector,
      selectorVerified: selector !== null,
      tag: o.tag ?? "DIV",
      id: null,
      classes: ["Panel", "Focusable"],
      ariaLabel: o.source === "aria-label" ? label : null,
      text: label,
      ownerText: "",
      label,
      labelSource: o.source ?? "text",
      labelOverflow: false,
      rect: { x: 0, y: 0, w: 300, h: 40 },
    },
    visibility: null,
    scrollPane: null,
    gpfocusWithin: (o.within ?? []).map((sel) => ({
      selector: sel,
      selectorVerified: true,
      tag: "DIV",
      id: null,
      classes: [],
      ariaLabel: null,
      text: "",
      ownerText: "",
      rect: null,
    })),
    activeElement: null,
    agree: false,
    deckyPluginRoot: false,
    deckyPanelLabels: [],
    quickAccessTab: null,
    visibleQuickAccessTab: o.qam ?? null,
    targetsScanned: [],
  };
}

/** No page carries the marker -- the state with a game in the foreground. */
const NO_RING: ReadFocusResult = {
  ok: false,
  reason:
    "gpfocus marker not found in any target - Steam client may have changed, or nothing currently " +
    "owns gamepad focus. Scanned: SharedJSContext, MainMenu_uid2, Steam Big Picture Mode.",
  fidelity: null,
  method: "cdp:fake",
  target: null,
  steamBuild: null,
  gpfocus: null,
  visibility: null,
  scrollPane: null,
  gpfocusWithin: [],
  activeElement: null,
  agree: false,
  deckyPluginRoot: false,
  deckyPanelLabels: [],
  quickAccessTab: null,
  visibleQuickAccessTab: null,
  targetsScanned: ["SharedJSContext", "MainMenu_uid2", "Steam Big Picture Mode"],
};

/** The QAM open on bonsAI, ring on Decky's Back button -- where LAUNCH-GAME-01 started. */
const QAM_START = ring("Back", {
  target: "QuickAccess_uid2",
  qam: "999",
  selector: "#quickaccess_content_999 > div.Panel.Focusable:nth-child(1) > button.DialogButton",
  source: "aria-label",
});

const menuEntry = (label: string): ReadFocusResult =>
  ring(label, {
    target: "MainMenu_uid2",
    source: "aria-label",
    selector:
      "#MainNavMenuContainer > div.Panel.Focusable:nth-child(1) > div:nth-child(1) > " +
      `div.Panel.Focusable:nth-child(${label === "Home" ? 2 : label === "Library" ? 3 : 1})`,
  });

const panelRow = (i: number): ReadFocusResult =>
  ring(PANEL_ROWS[i], {
    target: "MainMenu_uid2",
    selector: `#MainNavMenuContainer > div:nth-child(2) > div.Panel.Focusable:nth-child(1) > div.Panel.Focusable:nth-child(${i + 1})`,
  });

const control = (label: string): ReadFocusResult =>
  ring(label, { selector: "#Main > div.Panel.Focusable:nth-child(1) > div.Focusable:nth-child(1)", source: "aria-label" });

const modalButton = (label: string): ReadFocusResult =>
  ring(label, {
    tag: "BUTTON",
    selector:
      "#ModalDialogOverlay_Modal_0 > div.Panel.Focusable:nth-child(1) > form:nth-child(1) > " +
      `button.DialogButton._DialogLayout.${label === "Confirm" ? "Primary" : "Secondary"}:nth-child(1)`,
  });

// --------------------------------------------------------------------------
// A scripted Deck: answers reads, records presses, moves the ring the way the
// device was measured to.
// --------------------------------------------------------------------------

type Event =
  | { type: "press"; button: string }
  | { type: "read-focus"; label: string; ok: boolean }
  | { type: "read-tile"; appid: number | null }
  | { type: "read-page"; what: string };

type Screen = "qam" | "game" | "main-menu" | "game-panel" | "modal" | "home" | "library" | "app-page" | "other";

interface DeckSpec {
  running?: RunningApp[];
  library?: LibraryApp[];
  /** App ids on the Recent Games shelf, in order. */
  shelf?: number[];
  screen?: Screen;
  focus?: ReadFocusResult;
  /** What the app page's primary control reads. Default "Play". */
  appPageLabel?: string;
  /** What the exit dialog puts the ring on. Default "Confirm". */
  modalLabel?: string;
  /**
   * False models the Deck since 2026-10-10: a bare GUIDE reaches the Deck and
   * Steam's main menu stays shut (plan89-M3-STEAM-BUTTON). The QAM chord still
   * works. Default true.
   */
  guideOpensMenu?: boolean;
  /** The main window's route under the QAM. Default "/library/home". */
  underQam?: string;
  /** Which shelf tile holds the ring when the QAM closes over Home. Default 0. */
  homeShelfIndex?: number;
  /** False: SteamClient.Apps.TerminateApp is missing in SharedJSContext. Default true. */
  closeCall?: boolean;
  /**
   * The Library grid, row-major, `gridCols` per row (default 4). NOT a
   * measurement: the grid's markup was never read on a Deck. Modelled on the
   * shelf -- each tile's own <img src> carries its app id -- with only the rows
   * near the ring rendered (`gridRowsRendered`, default 3), so a target far
   * down the grid is not on the page until the walk gets near it. Default [].
   */
  grid?: number[];
  gridCols?: number;
  gridRowsRendered?: number;
  /** The Library opens with the ring on its tab bar, one DOWN above the grid. */
  libraryStartsOnTab?: boolean;
  /**
   * What the machine's process list shows when exitGame asks. Default: asked,
   * nothing alive. null: the check could not be made.
   */
  processes?: GameProcess[] | null;
  onPress?: (button: string, count: number) => void;
}

function fakeDeck(spec: DeckSpec = {}) {
  const running: RunningApp[] = [...(spec.running ?? [])];
  const library = spec.library ?? LIBRARY;
  const shelf = spec.shelf ?? [DRG.appid, HL2.appid, BROTATO.appid];
  const nameOf = (id: number): string => library.find((a) => a.appid === id)?.display_name ?? `app ${id}`;
  const grid = spec.grid ?? [];
  const cols = spec.gridCols ?? 4;
  const gridTileAt = (i: number): ReadFocusResult =>
    ring(nameOf(grid[i]), { selector: `#LibraryGrid > div.Panel.Focusable:nth-child(${i + 1})` });
  const LIBRARY_TAB = ring("Great on Deck", { selector: "#LibraryTabs > div.Panel.Focusable:nth-child(1)" });
  const tileAt = (i: number): ReadFocusResult =>
    ring(nameOf(shelf[i]), {
      selector: `div.Panel.Focusable:nth-child(1) > div:nth-child(2) > div.Panel.Focusable:nth-child(${i + 1})`,
    });

  const st: {
    screen: Screen;
    focus: ReadFocusResult;
    route: string;
    shelfIndex: number;
    panelIndex: number;
    appPage: number;
    spent: boolean;
    /** Index into the grid under the ring; -1 is the tab bar above it. */
    gridIndex: number;
  } = {
    screen: spec.screen ?? (running.length ? "game" : "qam"),
    focus: spec.focus ?? (running.length ? NO_RING : QAM_START),
    route: running.length ? "/apprunning" : (spec.underQam ?? "/library/home"),
    shelfIndex: 0,
    panelIndex: 0,
    appPage: 0,
    /** Set if A ever lands on Install/Update/Buy -- the thing that must never happen. */
    spent: false,
    gridIndex: 0,
  };
  const events: Event[] = [];
  const presses: string[] = [];
  const label = (): string => (st.focus.ok ? (st.focus.gpfocus?.label ?? "") : "");

  const pressFn = async ({ buttons }: PressOptions): Promise<PressResult> => {
    const b = buttons[0];
    presses.push(b);
    events.push({ type: "press", button: b });
    spec.onPress?.(b, presses.length);
    switch (st.screen) {
      case "qam":
      case "game":
        // A bare GUIDE opens the main menu: on Home with no game, on the game's
        // own entry (above Home) with one running. Anything else goes into the
        // game or the QAM and moves nothing this fake models.
        if (b === "GUIDE" && spec.guideOpensMenu !== false) {
          st.screen = "main-menu";
          st.focus = running.length ? menuEntry(running[0].display_name) : menuEntry("Home");
        }
        break;
      case "main-menu":
        if (b === "GUIDE") {
          st.screen = running.length ? "game" : "qam";
          st.focus = running.length ? NO_RING : QAM_START;
        } else if (b === "UP") {
          // The column: [the running game's entry], Home, Library.
          if (label() === "Library") st.focus = menuEntry("Home");
          else if (label() === "Home" && running.length) st.focus = menuEntry(running[0].display_name);
        } else if (b === "DOWN") {
          if (label() === "Home") st.focus = menuEntry("Library");
          else if (label() !== "Library") st.focus = menuEntry("Home");
        } else if (b === "A" && label() === "Library") {
          st.screen = "library";
          st.route = "/library";
          const onTab = spec.libraryStartsOnTab || grid.length === 0;
          st.gridIndex = onTab ? -1 : 0;
          st.focus = onTab ? LIBRARY_TAB : gridTileAt(0);
        } else if (b === "RIGHT") {
          if (running.length && label() === running[0].display_name) {
            st.screen = "game-panel";
            st.panelIndex = 0;
            st.focus = panelRow(0);
          }
        } else if (b === "A" && label() === "Home") {
          st.screen = "home";
          st.route = "/library/home";
          st.shelfIndex = 0;
          st.focus = tileAt(0);
        }
        break;
      case "game-panel":
        if (b === "DOWN") {
          st.panelIndex = Math.min(st.panelIndex + 1, PANEL_ROWS.length - 1);
          st.focus = panelRow(st.panelIndex);
        } else if (b === "UP") {
          st.panelIndex = Math.max(st.panelIndex - 1, 0);
          st.focus = panelRow(st.panelIndex);
        } else if (b === "A" && PANEL_ROWS[st.panelIndex] === "Exit game") {
          st.screen = "modal";
          st.focus = modalButton(spec.modalLabel ?? "Confirm");
        } else if (b === "A" && PANEL_ROWS[st.panelIndex] === "Resume game") {
          st.screen = "game";
          st.focus = NO_RING;
        }
        break;
      case "modal":
        if (b === "A" && label() === "Confirm") {
          const gone = running.shift();
          st.screen = "app-page";
          st.route = `/library/app/${gone?.appid ?? 0}`;
          st.focus = control("Play");
        } else if (b === "A") {
          st.screen = "game";
          st.focus = NO_RING;
        }
        break;
      case "library": {
        const i = st.gridIndex;
        let next = i;
        if (i < 0) {
          if (b === "DOWN" && grid.length) next = 0;
        } else if (b === "RIGHT" && i % cols < cols - 1 && i + 1 < grid.length) next = i + 1;
        else if (b === "LEFT" && i % cols > 0) next = i - 1;
        else if (b === "DOWN" && i + cols < grid.length) next = i + cols;
        else if (b === "UP" && i - cols >= 0) next = i - cols;
        if (next !== i) {
          st.gridIndex = next;
          st.focus = gridTileAt(next);
        }
        if (b === "A" && i >= 0) {
          st.screen = "app-page";
          st.appPage = grid[i];
          st.route = `/library/app/${st.appPage}`;
          st.focus = control(spec.appPageLabel ?? "Play");
        }
        break;
      }
      case "home":
        // With a game running underneath (a plugin reload left Home in
        // front, bonsAI 2026-09-25), the menu opens on Home, not on the game.
        if (b === "GUIDE" && spec.guideOpensMenu !== false) {
          st.screen = "main-menu";
          st.focus = menuEntry("Home");
        } else if (b === "RIGHT") {
          // The last tile stays put: the ring stops producing new elements.
          st.shelfIndex = Math.min(st.shelfIndex + 1, shelf.length - 1);
          st.focus = tileAt(st.shelfIndex);
        } else if (b === "LEFT") {
          st.shelfIndex = Math.max(st.shelfIndex - 1, 0);
          st.focus = tileAt(st.shelfIndex);
        } else if (b === "A") {
          st.screen = "app-page";
          st.appPage = shelf[st.shelfIndex];
          st.route = `/library/app/${st.appPage}`;
          st.focus = control(spec.appPageLabel ?? "Play");
        }
        break;
      case "app-page":
        if (b === "A" && label() === "Play") {
          running.push({ appid: st.appPage, display_name: nameOf(st.appPage) });
          st.screen = "game";
          st.route = "/apprunning";
          // Measured: the ring moves to an unlabelled container on /apprunning.
          st.focus = ring("", { selector: "#Main > div.Panel.Focusable:nth-child(1) > div:nth-child(4)" });
        } else if (b === "A") {
          st.spent = true;
        }
        break;
    }
    return { ok: true, fidelity: "steam-routed", method: "fake", buttons, holdMs: 80 };
  };

  /**
   * Hold-GUIDE-tap-A toggles the QAM -- the one chord that kept working when
   * the bare GUIDE stopped (plan89-M3-STEAM-BUTTON). Closing it over Home puts
   * the ring back on a Recent Games tile, as the drivers found by hand
   * (v1010-VOICE-BASE-GAME, p88-VOICE-WHOLE-GAME).
   */
  const chordFn = async (hold: string, tap: string): Promise<PressResult> => {
    const b = `${hold}+${tap}`;
    presses.push(b);
    events.push({ type: "press", button: b });
    spec.onPress?.(b, presses.length);
    if (hold === "GUIDE" && tap === "A") {
      if (st.screen === "qam") {
        if (st.route === "/library/home") {
          st.screen = "home";
          st.shelfIndex = spec.homeShelfIndex ?? 0;
          st.focus = tileAt(st.shelfIndex);
        } else {
          st.screen = "other";
          st.focus = control("Store");
        }
      } else if (st.screen === "home" || st.screen === "other" || st.screen === "game") {
        st.screen = "qam";
        st.focus = QAM_START;
      }
    }
    return { ok: true, fidelity: "wire-sent", method: "fake:chord", buttons: [hold, tap], holdMs: 0 };
  };

  const readFocusFn = async (): Promise<ReadFocusResult> => {
    events.push({ type: "read-focus", label: label(), ok: st.focus.ok });
    return st.focus;
  };

  const readPageFn = async (o: ReadPageOptions): Promise<ReadPageResult<unknown>> => {
    const ok = (value: unknown): ReadPageResult<unknown> => ({
      ok: true,
      value,
      target: { title: o.target ?? "", url: "" },
      targetsScanned: [],
      durationMs: 1,
    });
    // Steam's own close-game call. Checked first: it looks the game up in
    // RunningApps, so it also contains that word.
    if (o.expression.includes("TerminateApp")) {
      events.push({ type: "read-page", what: "TerminateApp" });
      assert.equal(o.target, "SharedJSContext");
      if (spec.closeCall === false) return ok({ ok: false, reason: "SteamClient.Apps.TerminateApp is not available" });
      const appid = Number(/=== (\d+)/.exec(o.expression)?.[1]);
      const i = running.findIndex((a) => a.appid === appid);
      if (i < 0) return ok({ ok: false, reason: `appid ${appid} is not in SteamUIStore.RunningApps` });
      running.splice(i, 1);
      st.screen = "app-page";
      st.route = `/library/app/${appid}`;
      st.focus = control("Play");
      return ok({ ok: true, gameid: String(appid) });
    }
    if (o.expression.includes("RunningApps")) {
      events.push({ type: "read-page", what: "RunningApps" });
      assert.equal(o.target, "SharedJSContext");
      return ok(running.map((a) => ({ ...a })));
    }
    if (o.expression.includes("allApps")) {
      events.push({ type: "read-page", what: "allApps" });
      assert.equal(o.target, "SharedJSContext");
      return ok(library.map((a) => ({ ...a })));
    }
    if (o.expression.includes("pathname")) {
      events.push({ type: "read-page", what: "route" });
      return ok(st.route);
    }
    // The tiles read (every tile with its box). Checked before the single-tile
    // read: it asks .gpfocus too.
    if (o.expression.includes("gridTiles")) {
      assert.equal(o.target, "Steam Big Picture Mode");
      const W = 100;
      const H = 150;
      const boxAt = (appid: number, row: number, col: number) => ({ appid, x: col * (W + 10), y: row * (H + 10), w: W, h: H });
      if (st.screen === "home") {
        const id = shelf[st.shelfIndex];
        events.push({ type: "read-tile", appid: id });
        return ok({
          ok: true,
          hasRing: true,
          text: nameOf(id),
          focused: { ...boxAt(id, 0, st.shelfIndex), depth: 0, src: `/assets/${id}/library_600x900.jpg` },
          row: [...shelf],
          tiles: shelf.map((a, i) => boxAt(a, 0, i)),
        });
      }
      if (st.screen === "library") {
        const at = st.gridIndex;
        const ringRow = at < 0 ? 0 : Math.floor(at / cols);
        const rendered = spec.gridRowsRendered ?? 3;
        const tiles = grid
          .map((a, i) => ({ a, i, row: Math.floor(i / cols) }))
          .filter((t) => t.row >= ringRow - 1 && t.row < ringRow + rendered)
          .map((t) => boxAt(t.a, t.row, t.i % cols));
        const id = at >= 0 ? grid[at] : null;
        events.push({ type: "read-tile", appid: id });
        return ok({
          ok: true,
          hasRing: true,
          text: id !== null ? nameOf(id) : "Great on Deck",
          focused:
            id !== null
              ? { ...boxAt(id, Math.floor(at / cols), at % cols), depth: 0, src: `/assets/${id}/library_600x900.jpg` }
              : null,
          row: null,
          tiles,
        });
      }
      events.push({ type: "read-tile", appid: null });
      return ok({ ok: true, hasRing: st.focus.ok, text: "", focused: null, row: null, tiles: [] });
    }
    if (o.expression.includes("gpfocus")) {
      assert.equal(o.target, "Steam Big Picture Mode");
      const appid = st.screen === "home" ? shelf[st.shelfIndex] : null;
      events.push({ type: "read-tile", appid });
      return ok(
        appid !== null
          ? {
              ok: true,
              appid,
              depth: 0,
              src: `/assets/${appid}/library_600x900.jpg`,
              text: `${nameOf(appid)}${nameOf(appid)}Last two weeks: 1.0 hrs`,
            }
          : { ok: true, appid: null, text: "" },
      );
    }
    return {
      ok: false,
      reason: `unexpected expression: ${o.expression.slice(0, 60)}`,
      value: null,
      target: null,
      targetsScanned: [],
      durationMs: 0,
    };
  };

  const seams: ExitGameOptions = {
    pressFn,
    chordFn,
    readFocusFn,
    readPageFn,
    sleepFn: async () => {},
    processCheckFn: async () => {
      events.push({ type: "read-page", what: "process-check" });
      return spec.processes === null
        ? { checked: false, skipped: false, reason: "fake: ssh did not answer" }
        : { checked: true, processes: spec.processes ?? [], how: "fake pgrep" };
    },
    cdpUrl: "http://127.0.0.1:1",
    writeEvidence: false,
  };
  return { seams, events, presses, running, state: st };
}

/**
 * For every A press, the read that authorised it: the nearest preceding focus
 * or tile read, provided no press came between. Route reads are informational
 * and skipped. "none" means an A went out with no read naming its target.
 */
function authorisingReads(events: Event[]): string[] {
  const out: string[] = [];
  events.forEach((e, i) => {
    if (e.type !== "press" || e.button !== "A") return;
    let j = i - 1;
    let found = "none";
    while (j >= 0) {
      const p = events[j];
      if (p.type === "press") break;
      if (p.type === "read-focus") {
        found = `focus:${p.label}`;
        break;
      }
      if (p.type === "read-tile") {
        found = `tile:${p.appid}`;
        break;
      }
      j--;
    }
    out.push(found);
  });
  return out;
}

const stageNames = (r: { stages: { stage: string }[] }): string[] => r.stages.map((s) => s.stage);

// --------------------------------------------------------------------------
// Refusals that never touch the Deck
// --------------------------------------------------------------------------

test("launchGame refuses without a name or an appid, and with both, before reading anything", async () => {
  const deck = fakeDeck();
  for (const args of [{}, { name: "Half-Life 2", appid: 220 }, { name: "   " }]) {
    const r = await launchGame({ ...deck.seams, ...args });
    assert.equal(r.ok, false);
    assert.match(r.reason ?? "", /exactly one of name or appid/);
    assert.equal(r.presses, 0);
    assert.equal(r.evidenceFile, null);
    assert.ok(r.checklist?.length, "a refusal hands back the manual steps");
  }
  assert.equal(deck.events.length, 0, "no read, no press");
});

test("resolveApp: exact name first, then a unique contains, and every ambiguity is a refusal", () => {
  // "half-life" is an exact (case-insensitive) hit even though it is also a
  // substring of two others -- exact wins, and that is the point of the order.
  const exact = resolveApp(LIBRARY, "half-life", null);
  assert.ok("app" in exact && exact.app.appid === 70);

  const unique = resolveApp(LIBRARY, "brot", null);
  assert.ok("app" in unique && unique.app.appid === BROTATO.appid);

  const many = resolveApp(LIBRARY, "life", null);
  assert.ok("reason" in many);
  assert.match(many.reason, /matches 3 apps/);
  assert.match(many.reason, /Half-Life 2 \(220\)/);
  assert.match(many.reason, /Half-Life: Alyx \(546560, not installed\)/);

  // The maintainer's Deck lists "007 - GoldenEye" twice: two non-Steam
  // shortcuts, two ids, one name. Which one is not the rig's call.
  const twins = resolveApp(LIBRARY, "007 - GoldenEye", null);
  assert.ok("reason" in twins);
  assert.match(twins.reason, /names 2 apps exactly/);

  const none = resolveApp(LIBRARY, "Portal", null);
  assert.ok("reason" in none && /no app in the library/.test(none.reason));

  const byId = resolveApp(LIBRARY, "", 220);
  assert.ok("app" in byId && byId.app.display_name === "Half-Life 2");
  const badId = resolveApp(LIBRARY, "", 1);
  assert.ok("reason" in badId && /appid 1 is not in the library/.test(badId.reason));
});

test("refusalLabel: the labels that spend disk or money, as a prefix; Play is not one", () => {
  assert.equal(refusalLabel("Install"), "Install");
  assert.equal(refusalLabel("Buy Half-Life 2"), "Buy");
  assert.equal(refusalLabel("update"), "Update");
  assert.equal(refusalLabel("Pre-load"), "Pre-load");
  assert.equal(refusalLabel("Add to Cart"), "Add to Cart");
  assert.equal(refusalLabel("Play"), null);
  assert.equal(refusalLabel(""), null);
});

test("inMainMenu keys on the measured container, the menu's own page, or the Home label", () => {
  assert.equal(inMainMenu(menuEntry("Home")), true);
  assert.equal(inMainMenu(panelRow(7)), true, "the game panel's rows live under the same container");
  assert.equal(inMainMenu(ring("Home")), true, "no selector at all: the Home label alone still counts");
  assert.equal(inMainMenu(QAM_START), false);
  assert.equal(inMainMenu(NO_RING), false);
  assert.equal(inMainMenu(control("Play")), false);
});

test("ownLabelOf refuses a name borrowed from an ancestor", () => {
  const borrowed = ring("Play", { source: "ancestor-text" });
  assert.equal(ownLabelOf(borrowed), "", "an ancestor's text says what the ring is inside, not what it is on");
  assert.equal(ownLabelOf(control("Play")), "Play");
});

// --------------------------------------------------------------------------
// launchGame
// --------------------------------------------------------------------------

test("a game that is already running is reported as such, with zero presses", async () => {
  const deck = fakeDeck({ running: [HL2] });
  const r = await launchGame({ ...deck.seams, name: "half-life 2" });
  assert.equal(r.ok, true);
  assert.equal(r.alreadyRunning, true);
  assert.equal(r.presses, 0);
  assert.equal(r.fidelity, null, "nothing was pressed, so nothing was routed");
  assert.deepEqual(r.running, { appid: 220, name: "Half-Life 2" });
  assert.equal(r.route, "/apprunning");
  assert.deepEqual(stageNames(r), ["read-running"]);
  assert.deepEqual(deck.presses, []);

  const byId = await launchGame({ ...fakeDeck({ running: [HL2] }).seams, appid: 220 });
  assert.equal(byId.alreadyRunning, true);
});

test("RULE 3: a different game running is a refusal that names it and points at deck_exitGame", async () => {
  const deck = fakeDeck({ running: [HL2] });
  const r = await launchGame({ ...deck.seams, appid: BROTATO.appid });
  assert.equal(r.ok, false);
  assert.match(r.reason ?? "", /"Half-Life 2" \(appid 220\) is already running/);
  assert.match(r.reason ?? "", /deck_exitGame/);
  assert.equal(r.presses, 0);
  assert.ok(!deck.presses.includes("A"), "no A press, ever, while another game is up");
  assert.deepEqual(deck.presses, []);
  assert.equal(deck.running.length, 1, "the running game was left alone");

  // A name that only CONTAINS the running game's name is not the running game
  // -- but the refusal says how to say so if it was meant.
  const partial = await launchGame({ ...fakeDeck({ running: [HL2] }).seams, name: "Half-Life" });
  assert.equal(partial.ok, false);
  assert.match(partial.reason ?? "", /pass appid 220 if that is the game you mean/);
});

test("an ambiguous name is refused before any press, listing the candidates", async () => {
  const deck = fakeDeck();
  const r = await launchGame({ ...deck.seams, name: "life" });
  assert.equal(r.ok, false);
  assert.match(r.reason ?? "", /matches 3 apps/);
  assert.equal(r.presses, 0);
  assert.deepEqual(stageNames(r), ["read-running", "resolve-app"]);
  assert.deepEqual(deck.presses, []);
});

test("a game that is not installed is refused: Play would become Install", async () => {
  const deck = fakeDeck();
  const r = await launchGame({ ...deck.seams, name: "Half-Life: Alyx" });
  assert.equal(r.ok, false);
  assert.match(r.reason ?? "", /not installed/);
  assert.match(r.reason ?? "", /spends disk/);
  assert.equal(r.appid, 546560, "the refusal still says which app it resolved to");
  assert.equal(r.presses, 0);
  assert.deepEqual(deck.presses, []);
});

test("happy path: GUIDE, A on Home, RIGHT along the shelf, A on the tile, A on Play -- each A after a read", async () => {
  const deck = fakeDeck({ shelf: [DRG.appid, HL2.appid, BROTATO.appid] });
  const r = await launchGame({ ...deck.seams, name: "Half-Life 2" });

  assert.equal(r.ok, true, r.reason);
  assert.deepEqual(deck.presses, ["GUIDE", "A", "RIGHT", "A", "A"]);
  assert.deepEqual(
    authorisingReads(deck.events),
    ["focus:Home", "tile:220", "focus:Play"],
    "every A is preceded by the read that named its target, with no press in between",
  );
  assert.deepEqual(stageNames(r), [
    "read-running",
    "resolve-app",
    "open-main-menu",
    "go-home",
    "find-tile",
    "open-app-page",
    "press-play",
  ]);
  assert.ok(r.stages.every((s) => s.ok), r.stages.map((s) => `${s.stage}: ${s.detail}`).join("\n"));
  assert.equal(r.presses, 5);
  assert.equal(r.fidelity, "steam-routed");
  assert.equal(r.stopped, false);
  assert.equal(r.checklist, undefined, "a success carries no manual checklist");
  assert.deepEqual(r.running, { appid: 220, name: "Half-Life 2" });
  assert.equal(r.route, "/apprunning");
  assert.deepEqual(deck.running, [HL2]);
  assert.equal(deck.state.spent, false);
  assert.ok(r.seen.includes("Deep Rock Galactic: Survivor (2321470)"), `seen: ${r.seen.join(" | ")}`);
  assert.ok(r.seen.includes("Half-Life 2 (220)"));
  assert.match(r.summary, /launched "Half-Life 2" \(appid 220\)/);
  assert.equal(r.via, "steam-menu", "the Steam button worked, and the result says that was the route");

  const tileStage = r.stages.find((s) => s.stage === "find-tile");
  assert.match(tileStage?.detail ?? "", /\/assets\/220\//, "the tile was identified by its own image, not its text");
});

test("the main menu already open is not toggled shut: no GUIDE press, straight to Home", async () => {
  // GUIDE is a toggle. A launch that started inside the menu and pressed it
  // anyway would close the menu and then press A on whatever was underneath.
  const deck = fakeDeck({ screen: "main-menu", focus: menuEntry("Home") });
  const r = await launchGame({ ...deck.seams, appid: HL2.appid });
  assert.equal(r.ok, true, r.reason);
  assert.equal(deck.presses[0], "A", "the first press is A on Home, read on Home");
  assert.ok(!deck.presses.includes("GUIDE"));
  const menuStage = r.stages.find((s) => s.stage === "open-main-menu");
  assert.equal(menuStage?.presses, 0);
  assert.match(menuStage?.detail ?? "", /already open/);
});

test("RULE 2: an app page offering Install instead of Play is refused, and A is not pressed there", async () => {
  const deck = fakeDeck({ shelf: [HL2.appid], appPageLabel: "Install" });
  const r = await launchGame({ ...deck.seams, name: "Half-Life 2" });

  assert.equal(r.ok, false);
  assert.match(r.reason ?? "", /shows "Install" instead of "Play"/);
  assert.match(r.reason ?? "", /rule 2/);
  // GUIDE, A on Home, A on the tile -- and that is where it stops.
  assert.deepEqual(deck.presses, ["GUIDE", "A", "A"]);
  assert.equal(deck.state.spent, false, "no A landed on Install");
  assert.deepEqual(deck.running, []);
  const stage = r.stages.find((s) => s.stage === "open-app-page");
  assert.equal(stage?.ok, false);
  assert.ok(r.checklist?.length);
});

test("Home-screen route: a game not on the shelf is refused, because the Library is out of reach without the menu", async () => {
  const deck = fakeDeck({ guideOpensMenu: false, shelf: [DRG.appid, BROTATO.appid], grid: [HL2.appid] });
  const r = await launchGame({ ...deck.seams, name: "Half-Life 2" });

  assert.equal(r.ok, false);
  assert.match(r.reason ?? "", /is not on the Recent Games shelf/);
  assert.match(r.reason ?? "", /Library grid cannot be reached on this route/);
  assert.match(r.reason ?? "", /play it once by hand/i);
  // Two tiles: RIGHT reaches the second, the next RIGHT moves nothing (the
  // shelf's end), then LEFT back to the first and once more against the start.
  assert.deepEqual(deck.presses, ["GUIDE", "GUIDE+A", "RIGHT", "RIGHT", "LEFT", "LEFT"]);
  assert.ok(!deck.presses.includes("A"));
  assert.ok(r.seen.includes("Deep Rock Galactic: Survivor (2321470)"));
  assert.ok(r.seen.includes("Brotato (1942280)"));
  assert.ok(!r.seen.some((s) => s.includes("220")));
  const stage = r.stages.find((s) => s.stage === "find-tile");
  assert.equal(stage?.ok, false);
  assert.match(stage?.detail ?? "", /stopped moving/);
  assert.deepEqual(deck.running, []);
});

// --------------------------------------------------------------------------
// launchGame from the Library grid (plan 11 lane F). The grid in the fake is
// MODELLED ON THE SHELF, not measured: see DeckSpec.grid.
// --------------------------------------------------------------------------

/** Eight installed titles, none of them recently played: the 2026-09-18 shape. */
const GOW: RunningApp = { appid: 1593500, display_name: "God of War" };
const HK: RunningApp = { appid: 367520, display_name: "Hollow Knight" };
const BMS: RunningApp = { appid: 362890, display_name: "Black Mesa" };
const DOOM64: RunningApp = { appid: 1148590, display_name: "DOOM 64" };
const BIG_LIBRARY: LibraryApp[] = [
  ...LIBRARY,
  { ...GOW, installed: true },
  { ...HK, installed: true },
  { ...BMS, installed: true },
  { ...DOOM64, installed: true },
];
/** Row-major, 4 per row: HL2 sits at row 1, column 2. */
const GRID = [70, BMS.appid, BROTATO.appid, DRG.appid, DOOM64.appid, GOW.appid, HL2.appid, HK.appid];

test("a game off the shelf is reached through the Library grid: every A after a read, presses bounded, route reported", async () => {
  const deck = fakeDeck({ library: BIG_LIBRARY, shelf: [DRG.appid, BROTATO.appid], grid: GRID });
  const r = await launchGame({ ...deck.seams, name: "Half-Life 2" });

  assert.equal(r.ok, true, r.reason);
  assert.equal(r.launchRoute, "library");
  assert.equal(r.via, "steam-menu");
  assert.deepEqual(deck.running, [HL2]);
  assert.deepEqual(deck.presses, [
    "GUIDE", "A", // Home
    "RIGHT", "RIGHT", // the shelf, to its end
    "GUIDE", "DOWN", "A", // the menu again, Home -> Library, A
    "DOWN", "RIGHT", "RIGHT", // the grid: a row down, two columns right
    "A", "A", // the tile, then Play
  ]);
  assert.deepEqual(
    authorisingReads(deck.events),
    ["focus:Home", "focus:Library", "tile:220", "focus:Play"],
    "every A is preceded by the read that named its target, with no press in between",
  );
  assert.deepEqual(stageNames(r), [
    "read-running",
    "resolve-app",
    "open-main-menu",
    "go-home",
    "find-tile",
    "open-library",
    "find-grid-tile",
    "open-app-page",
    "press-play",
  ]);
  assert.equal(r.stages.find((s) => s.stage === "find-tile")?.ok, false, "the shelf miss is reported as the miss it was");
  const grid = r.stages.find((s) => s.stage === "find-grid-tile");
  assert.equal(grid?.ok, true);
  assert.equal(grid?.presses, 3);
  assert.match(grid?.detail ?? "", /\/assets\/220\//, "the grid tile was identified by its own image");
  assert.equal(r.fidelity, "steam-routed");
  assert.match(r.summary, /from the Library grid/);
  assert.match(r.summary, /device-unverified/);
  assert.equal(deck.state.spent, false);
});

test("a focus read follows every press on the grid walk", async () => {
  const deck = fakeDeck({ library: BIG_LIBRARY, shelf: [DRG.appid], grid: GRID, libraryStartsOnTab: true });
  const r = await launchGame({ ...deck.seams, appid: HK.appid });
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.launchRoute, "library");
  // From the tab bar: DOWN into the grid at index 0, DOWN to row 1, RIGHT x3 to HK (index 7).
  const libraryA = deck.events.findIndex((e) => e.type === "read-focus" && e.label === "Library");
  const gridEvents = deck.events.slice(libraryA);
  const gridPresses = gridEvents.filter((e) => e.type === "press" && e.button !== "A");
  assert.deepEqual(
    gridPresses.map((e) => (e as { button: string }).button),
    ["DOWN", "DOWN", "RIGHT", "RIGHT", "RIGHT"],
  );
  gridEvents.forEach((e, i) => {
    if (e.type !== "press" || e.button === "A") return;
    assert.equal(gridEvents[i + 1]?.type, "read-focus", `press ${i} on the grid was not followed by a focus read`);
  });
  assert.deepEqual(deck.running, [HK]);
});

test("the grid walk scrolls DOWN to a tile that is not on the page yet, then steers to it", async () => {
  // 40 tiles, 4 per row, only three rows rendered near the ring: the target
  // at index 37 (row 9) is not in the DOM until the ring is close.
  const filler = Array.from({ length: 37 }, (_, i) => 500000 + i);
  const lib: LibraryApp[] = [...BIG_LIBRARY, ...filler.map((a) => ({ appid: a, display_name: `Filler ${a}`, installed: true }))];
  const deck = fakeDeck({ library: lib, shelf: [DRG.appid], grid: [...filler, BMS.appid, 600001, 600002] });
  const r = await launchGame({ ...deck.seams, appid: BMS.appid });
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.launchRoute, "library");
  const grid = r.stages.find((s) => s.stage === "find-grid-tile");
  assert.equal(grid?.presses, 10, "nine rows down and one column right");
  assert.deepEqual(deck.running, [BMS]);
});

test("the bounded grid walk refuses after the budget and names the last tile seen", async () => {
  const filler = Array.from({ length: 60 }, (_, i) => 700000 + i);
  const lib: LibraryApp[] = [...BIG_LIBRARY, ...filler.map((a) => ({ appid: a, display_name: `Filler ${a}`, installed: true }))];
  // Doom 64 is installed and on neither the shelf nor the grid (another tab).
  const deck = fakeDeck({ library: lib, shelf: [DRG.appid], grid: filler });
  const r = await launchGame({ ...deck.seams, appid: DOOM64.appid, budget: 5 });

  assert.equal(r.ok, false);
  assert.equal(r.launchRoute, undefined);
  const grid = r.stages.find((s) => s.stage === "find-grid-tile");
  assert.equal(grid?.ok, false);
  assert.equal(grid?.presses, 5, "the walk stopped at its budget");
  assert.match(grid?.detail ?? "", /budget of 5/);
  // Five DOWN presses from index 0 land on index 20.
  assert.match(r.reason ?? "", /last tile seen: Filler 700020 \(700020\)/);
  assert.match(r.summary, /last tile: Filler 700020/);
  assert.equal(deck.presses.filter((b) => b === "A").length, 2, "A on Home and A on Library -- never on a tile");
  assert.deepEqual(deck.running, []);
  assert.equal(deck.state.spent, false);
});

test("the grid walk ends when the ring stops moving, naming the last tile", async () => {
  const deck = fakeDeck({ library: BIG_LIBRARY, shelf: [DRG.appid], grid: [70, BMS.appid] });
  const r = await launchGame({ ...deck.seams, appid: DOOM64.appid });
  assert.equal(r.ok, false);
  const grid = r.stages.find((s) => s.stage === "find-grid-tile");
  assert.match(grid?.detail ?? "", /did not move DOWN/);
  assert.match(r.reason ?? "", /last tile seen: Half-Life \(70\)/);
  assert.equal(deck.presses.filter((b) => b === "A").length, 2);
});

test("gridStep: off a tile goes DOWN; rows before columns; an unseen target goes DOWN", () => {
  const at = (appid: number, row: number, col: number) => ({ appid, x: col * 110, y: row * 160, w: 100, h: 150 });
  const tiles = [at(1, 0, 0), at(2, 0, 1), at(3, 1, 0), at(4, 1, 3)];
  assert.equal(gridStep(null, tiles, 2).dir, "DOWN");
  assert.equal(gridStep(at(1, 0, 0), tiles, 2).dir, "RIGHT");
  assert.equal(gridStep(at(2, 0, 1), tiles, 1).dir, "LEFT");
  assert.equal(gridStep(at(1, 0, 0), tiles, 4).dir, "DOWN", "a row below wins over the column");
  assert.equal(gridStep(at(4, 1, 3), tiles, 2).dir, "UP");
  assert.equal(gridStep(at(1, 0, 0), tiles, 99).dir, "DOWN");
});

// --------------------------------------------------------------------------
// deck_listGames
// --------------------------------------------------------------------------

test("listGames returns installed titles, the shelf and RunningApps with zero presses", async () => {
  const deck = fakeDeck({
    library: BIG_LIBRARY,
    shelf: [DRG.appid, BROTATO.appid],
    screen: "home",
  });
  deck.state.focus = ring("Deep Rock Galactic: Survivor");
  const r = await listGames({ cdpUrl: deck.seams.cdpUrl, readPageFn: deck.seams.readPageFn });

  assert.equal(r.ok, true, r.reason);
  assert.equal(r.presses, 0);
  assert.deepEqual(deck.presses, [], "nothing was pressed");
  assert.ok(!deck.events.some((e) => e.type === "press"));
  assert.equal(r.installed.length, BIG_LIBRARY.filter((a) => a.installed).length);
  assert.equal(r.notInstalledCount, 1, "Half-Life: Alyx is in the library, not installed, and not listed");
  assert.ok(!r.installed.some((a) => a.appid === 546560));
  assert.deepEqual(r.installed.find((a) => a.appid === 220), { appid: 220, name: "Half-Life 2", nonSteam: false });
  assert.deepEqual(
    r.installed.filter((a) => a.nonSteam).map((a) => a.appid),
    [4000000001, 4000000002],
    "the two GoldenEye shortcuts are non-Steam",
  );
  assert.deepEqual(r.recentShelf, [DRG.appid, BROTATO.appid]);
  assert.deepEqual(r.running, []);
  assert.equal(r.route, "/library/home");
  assert.match(r.summary, /nothing was pressed/);
});

test("listGames off the Home screen says why there is no shelf, and lists what is running", async () => {
  const deck = fakeDeck({ running: [HL2] });
  const r = await listGames({ cdpUrl: deck.seams.cdpUrl, readPageFn: deck.seams.readPageFn });
  assert.equal(r.ok, true);
  assert.equal(r.recentShelf, null);
  assert.match(r.recentShelfReason ?? "", /\/apprunning, not the Home screen/);
  assert.deepEqual(r.running, [{ appid: 220, name: "Half-Life 2" }]);
  assert.deepEqual(deck.presses, []);
});

test("listGames reads app_type when allApps carries it", async () => {
  const deck = fakeDeck();
  const r = await listGames({
    cdpUrl: deck.seams.cdpUrl,
    readPageFn: async (o) => {
      const base = await deck.seams.readPageFn!(o);
      if (!o.expression.includes("allApps")) return base;
      return { ...base, value: [{ appid: 12345, display_name: "Shortcut, low id", installed: true, app_type: 0x40000000 },
        { appid: 3000000000, display_name: "Steam game, odd id", installed: true, app_type: 1 }] };
    },
  });
  assert.deepEqual(r.installed.map((a) => [a.appid, a.nonSteam]), [[12345, true], [3000000000, false]]);
});

test("the shelf budget bounds the walk", async () => {
  const shelf = Array.from({ length: 30 }, (_, i) => 100000 + i);
  const deck = fakeDeck({ shelf: [...shelf, HL2.appid] });
  const r = await launchGame({ ...deck.seams, name: "Half-Life 2", budget: 5 });
  assert.equal(r.ok, false);
  assert.equal(deck.presses.filter((b) => b === "RIGHT").length, 5);
  assert.match(r.stages.find((s) => s.stage === "find-tile")?.detail ?? "", /budget of 5/);
});

test("press-play that never shows up in RunningApps is a finding, not a success", async () => {
  const deck = fakeDeck({ shelf: [HL2.appid] });
  // The game "launches" into a launcher that never registers: RunningApps
  // stays empty. Keep the wait tiny; the sleep seam makes polls free.
  const noRegister: GameSessionOptions = {
    ...deck.seams,
    readPageFn: async (o) => {
      const r = await deck.seams.readPageFn!(o);
      return o.expression.includes("RunningApps") ? { ...r, value: [] } : r;
    },
  };
  const r = await launchGame({ ...noRegister, name: "Half-Life 2", waitMs: 30 });
  assert.equal(r.ok, false);
  assert.match(r.reason ?? "", /never listed appid 220 within 30ms/);
  assert.deepEqual(deck.presses, ["GUIDE", "A", "A", "A"], "the presses were made; the confirmation was not");
  assert.equal(r.stages.find((s) => s.stage === "press-play")?.ok, false);
  assert.equal(
    r.fidelity,
    "wire-sent",
    "presses were spent and RunningApps never confirmed the launch, so nothing established that they reached Steam -- this path claimed steam-routed off rig.presses > 0 until 2026-09-08",
  );
});

// --------------------------------------------------------------------------
// launchGame when the Steam button no longer opens Steam's menu
// (plan89-M3-STEAM-BUTTON: a clean BTN_MODE down and up reaches the Deck, the
// menu stays shut; the QAM chord still works)
// --------------------------------------------------------------------------

test("Steam's menu does not open: the Home-screen route closes the QAM, walks the shelf, and the game starts", async () => {
  const deck = fakeDeck({ guideOpensMenu: false, shelf: [DRG.appid, HL2.appid, BROTATO.appid] });
  const r = await launchGame({ ...deck.seams, name: "Half-Life 2" });

  // What the driver sees on the Deck: the game is running.
  assert.equal(r.ok, true, r.reason);
  assert.deepEqual(deck.running, [HL2]);
  assert.deepEqual(r.running, { appid: 220, name: "Half-Life 2" });
  assert.equal(r.via, "home-screen");
  // The GUIDE try, the chord that closes the QAM, then the drivers' own route.
  assert.deepEqual(deck.presses, ["GUIDE", "GUIDE+A", "RIGHT", "A", "A"]);
  assert.deepEqual(authorisingReads(deck.events), ["tile:220", "focus:Play"], "every A still follows the read naming it");
  assert.deepEqual(stageNames(r), [
    "read-running",
    "resolve-app",
    "open-main-menu",
    "close-qam",
    "home-screen",
    "find-tile",
    "open-app-page",
    "press-play",
  ]);
  const menu = r.stages.find((s) => s.stage === "open-main-menu");
  assert.equal(menu?.ok, false, "the GUIDE try is reported as the miss it was");
  assert.match(r.summary, /Home-screen route/);
  assert.match(r.summary, /Steam's main menu did not open/);
  assert.equal(r.fidelity, "steam-routed", "RunningApps confirmed a launch the presses made");
  assert.equal(deck.state.spent, false);
});

test("Home-screen route: a ring mid-shelf walks back LEFT to a game before it", async () => {
  const deck = fakeDeck({
    guideOpensMenu: false,
    shelf: [DRG.appid, HL2.appid, BROTATO.appid],
    homeShelfIndex: 2,
  });
  const r = await launchGame({ ...deck.seams, appid: DRG.appid });
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.via, "home-screen");
  // RIGHT from the last tile moves nothing (the shelf's end), then LEFT twice.
  assert.deepEqual(deck.presses, ["GUIDE", "GUIDE+A", "RIGHT", "LEFT", "LEFT", "A", "A"]);
  assert.deepEqual(authorisingReads(deck.events), [`tile:${DRG.appid}`, "focus:Play"]);
  assert.deepEqual(deck.running, [DRG]);
});

test("Home-screen route: not on the Home screen under the QAM is a refusal, and A is never pressed", async () => {
  // Without the menu there is no honest way Home: the rig never presses B.
  const deck = fakeDeck({ guideOpensMenu: false, underQam: "/library/app/70" });
  const r = await launchGame({ ...deck.seams, name: "Half-Life 2" });
  assert.equal(r.ok, false);
  assert.match(r.reason ?? "", /Steam's main menu did not open/);
  assert.match(r.reason ?? "", /not on the Home screen/);
  assert.match(r.reason ?? "", /\/library\/app\/70/);
  assert.deepEqual(deck.presses, ["GUIDE", "GUIDE+A"]);
  assert.ok(!deck.presses.includes("A"));
  assert.deepEqual(deck.running, []);
  assert.ok(r.checklist?.length);
});

// --------------------------------------------------------------------------
// exitGame
// --------------------------------------------------------------------------

test("nothing running: exitGame reports it and presses nothing", async () => {
  const deck = fakeDeck();
  const r = await exitGame(deck.seams);
  assert.equal(r.ok, true);
  assert.equal(r.nothingRunning, true);
  assert.equal(r.presses, 0);
  assert.equal(r.running, null);
  assert.deepEqual(deck.presses, []);
});

test("happy path: GUIDE, RIGHT, DOWN x7 to Exit game, A, A on Confirm -- then RunningApps empties", async () => {
  const deck = fakeDeck({ running: [HL2] });
  const r = await exitGame(deck.seams);

  assert.equal(r.ok, true, r.reason);
  assert.deepEqual(deck.presses, ["GUIDE", "RIGHT", ...Array(7).fill("DOWN"), "A", "A"]);
  assert.deepEqual(authorisingReads(deck.events), ["focus:Exit game", "focus:Confirm"]);
  assert.deepEqual(stageNames(r), ["read-running", "open-main-menu", "find-exit", "confirm"]);
  assert.ok(r.stages.every((s) => s.ok), r.stages.map((s) => `${s.stage}: ${s.detail}`).join("\n"));
  assert.equal(r.appid, 220);
  assert.equal(r.name, "Half-Life 2");
  assert.equal(r.running, null);
  assert.equal(r.route, "/library/app/220", "measured post-exit state: back on the app page");
  assert.match(r.summary, /ring on <DIV> "Play"/);
  assert.deepEqual(deck.running, []);
  assert.match(r.stages[2].detail, /RIGHT landed on "Resume game" \(as measured\)/);
  assert.ok(r.seen.includes("Exit game"));
  assert.ok(r.seen.includes("Confirm"));
});

test("the exit dialog with the ring anywhere but Confirm is a refusal: the second A is never pressed", async () => {
  const deck = fakeDeck({ running: [HL2], modalLabel: "Cancel" });
  const r = await exitGame(deck.seams);

  assert.equal(r.ok, false);
  assert.match(r.reason ?? "", /not on a control labelled exactly "Confirm"/);
  assert.match(r.reason ?? "", /never guesses between Cancel and Confirm/);
  assert.equal(deck.presses.filter((b) => b === "A").length, 1, "only the A on Exit game went out");
  assert.deepEqual(deck.running, [HL2], "the game is still running");
  assert.deepEqual(r.running, { appid: 220, name: "Half-Life 2" });
  const stage = r.stages.find((s) => s.stage === "confirm");
  assert.equal(stage?.ok, false);
  assert.equal(stage?.presses, 1);
  assert.match(stage?.detail ?? "", /in a modal/);
});

test("with the menu already open on Home and a game up, exitGame walks UP to the game's entry instead of toggling", async () => {
  const deck = fakeDeck({ running: [HL2], screen: "main-menu", focus: menuEntry("Home") });
  const r = await exitGame(deck.seams);
  assert.equal(r.ok, true, r.reason);
  assert.deepEqual(deck.presses, ["UP", "RIGHT", ...Array(7).fill("DOWN"), "A", "A"]);
  assert.ok(!deck.presses.includes("GUIDE"));
});

test("GUIDE that opens the menu but never reaches the running game's entry is a refusal", async () => {
  // Model a Steam build whose menu opens on Home even with a game up, and
  // whose game entry the ring can never be read on.
  const deck = fakeDeck({ running: [HL2] });
  const seams: ExitGameOptions = {
    ...deck.seams,
    readFocusFn: async (base, timeoutMs) => {
      const r = await deck.seams.readFocusFn!(base, timeoutMs);
      return r.ok && r.gpfocus?.label === "Half-Life 2" ? menuEntry("Home") : r;
    },
  };
  const r = await exitGame(seams);
  assert.equal(r.ok, false);
  assert.match(r.reason ?? "", /never reached an entry named "Half-Life 2"/);
  assert.deepEqual(deck.presses, ["GUIDE", "UP"], "one UP, and the ring read as unmoved, ends the walk");
  assert.ok(!deck.presses.includes("A"));
  assert.ok(
    !deck.events.some((e) => e.type === "read-page" && e.what === "TerminateApp"),
    "a menu that DID open is a refusal, never a reason to close the game some other way",
  );
});

test("Home in front of a game still running underneath: the menu opens on Home, and exitGame walks UP and exits", async () => {
  // bonsAI 2026-09-25 / -26: a plugin reload left Steam's Home screen in
  // front of the running game, and the exit tool stopped there.
  const deck = fakeDeck({ running: [HL2], screen: "home" });
  deck.state.focus = ring("Brotato");
  deck.state.route = "/library/home";
  const r = await exitGame(deck.seams);

  assert.equal(r.ok, true, r.reason);
  assert.deepEqual(deck.presses, ["GUIDE", "UP", "RIGHT", ...Array(7).fill("DOWN"), "A", "A"]);
  assert.deepEqual(authorisingReads(deck.events), ["focus:Exit game", "focus:Confirm"]);
  const menu = r.stages.find((s) => s.stage === "open-main-menu");
  assert.equal(menu?.ok, true);
  assert.equal(menu?.presses, 2);
  assert.match(menu?.detail ?? "", /running underneath/);
  assert.deepEqual(deck.running, []);
  assert.equal(r.via, "steam-menu");
});

// --------------------------------------------------------------------------
// exitGame does not believe an empty RunningApps alone (bonsAI 2026-09-19)
// --------------------------------------------------------------------------

test("RunningApps empty but a game process alive: processAlive with the pid, no exit claimed, nothing pressed", async () => {
  const deck = fakeDeck({
    processes: [
      {
        pid: 4242,
        appid: BMS.appid,
        command: "/home/deck/.local/share/Steam/ubuntu12_32/reaper SteamLaunch AppId=362890 -- steam-launch-wrapper -- bms.exe",
      },
    ],
  });
  const r = await exitGame(deck.seams);

  assert.equal(r.ok, false, "an exit must not be claimed while the process is alive");
  assert.notEqual(r.nothingRunning, true);
  assert.equal(r.processAlive, true);
  assert.equal(r.pid, 4242);
  assert.equal(r.appid, BMS.appid);
  assert.match(r.reason ?? "", /RunningApps is empty/);
  assert.match(r.reason ?? "", /pid 4242/);
  assert.match(r.reason ?? "", /NOT called exited/);
  assert.match(r.reason ?? "", /nothing was killed/);
  assert.match(r.processCheck ?? "", /pid 4242/);
  assert.equal(r.presses, 0);
  assert.deepEqual(deck.presses, []);
  assert.ok(!deck.events.some((e) => e.type === "read-page" && e.what === "TerminateApp"), "nothing closed the game");
  assert.deepEqual(stageNames(r), ["read-running", "process-check"]);
  assert.equal(r.stages[1].ok, false);
});

test("RunningApps empty and the process list agrees: nothingRunning, processAlive false", async () => {
  const deck = fakeDeck();
  const r = await exitGame(deck.seams);
  assert.equal(r.ok, true);
  assert.equal(r.nothingRunning, true);
  assert.equal(r.processAlive, false);
  assert.match(r.summary, /process list agrees/);
  assert.ok(deck.events.some((e) => e.type === "read-page" && e.what === "process-check"));
});

test("RunningApps empty and the process list could not be asked: processAlive null, and the summary says it rests on RunningApps", async () => {
  const deck = fakeDeck({ processes: null });
  const r = await exitGame(deck.seams);
  assert.equal(r.ok, true);
  assert.equal(r.nothingRunning, true);
  assert.equal(r.processAlive, null);
  assert.match(r.summary, /rests on RunningApps alone/);
  assert.match(r.processCheck ?? "", /not made/);
});

test("checkGameProcesses: skipped on Windows, parsed on SteamOS, and a failed SSH is never 'nothing running'", () => {
  const steamos = { name: "deck", kind: "deck", os: "steamos", local: false, host: "10.0.0.2", user: "deck" } as Machine;
  const windows = { name: "this-pc", kind: "standin", os: "windows", local: true } as Machine;
  let asked: string | null = null;

  const win = checkGameProcesses(windows, () => {
    throw new Error("must not be called on windows");
  });
  assert.equal(win.checked, false);
  assert.ok(!win.checked && win.skipped && /Windows/.test(win.reason));

  const alive = checkGameProcesses(steamos, (_m, cmd) => {
    asked = cmd;
    return { status: 0, stdout: "4242 /home/deck/.local/share/Steam/ubuntu12_32/reaper SteamLaunch AppId=362890 -- x\n", stderr: "" };
  });
  assert.ok(alive.checked);
  assert.deepEqual(alive.checked && alive.processes.map((p) => [p.pid, p.appid]), [[4242, 362890]]);
  assert.match(asked ?? "", /pgrep -af 'SteamLaunch AppId=\[0-9\]'/);

  const none = checkGameProcesses(steamos, () => ({ status: 1, stdout: "", stderr: "" }));
  assert.ok(none.checked && none.processes.length === 0);

  const down = checkGameProcesses(steamos, () => ({ status: 255, stdout: "", stderr: "ssh: connect to host 10.0.0.2 port 22: Connection timed out" }));
  assert.equal(down.checked, false, "ssh's 255 is a check not made, not an empty process list");
  assert.ok(!down.checked && !down.skipped && /255/.test(down.reason) && /timed out/.test(down.reason));

  assert.deepEqual(parseGameProcesses("  17 reaper SteamLaunch AppId=220 -- hl2\n\n"), [
    { pid: 17, appid: 220, command: "reaper SteamLaunch AppId=220 -- hl2" },
  ]);
});

// --------------------------------------------------------------------------
// exitGame when the Steam button no longer opens Steam's menu
// --------------------------------------------------------------------------

test("Steam's menu does not open: exitGame closes the game with Steam's own close call, and says it was not the menu", async () => {
  const deck = fakeDeck({ running: [HL2], guideOpensMenu: false });
  const r = await exitGame(deck.seams);

  // What the driver sees on the Deck: the game is gone.
  assert.equal(r.ok, true, r.reason);
  assert.deepEqual(deck.running, []);
  assert.equal(r.running, null);
  assert.equal(r.via, "steam-close-call");
  assert.deepEqual(deck.presses, ["GUIDE"], "the GUIDE try, and no press after it");
  assert.deepEqual(stageNames(r), ["read-running", "open-main-menu", "close-call"]);
  assert.equal(r.stages[1].ok, false, "the GUIDE try is reported as the miss it was");
  assert.equal(r.stages[2].ok, true);
  assert.match(r.summary, /closed without the Steam menu/);
  assert.match(r.summary, /TerminateApp/);
  assert.equal(r.route, "/library/app/220");
  assert.equal(
    r.fidelity,
    "wire-sent",
    "the game left RunningApps because of a call, not a press: nothing shows the GUIDE press reached Steam",
  );
  const pressAt = deck.events.findIndex((e) => e.type === "press");
  const callAt = deck.events.findIndex((e) => e.type === "read-page" && e.what === "TerminateApp");
  assert.ok(callAt > pressAt && pressAt >= 0, "the close call comes only after the GUIDE try");
});

test("Steam's menu does not open and the close call is unavailable: a refusal, the game still running", async () => {
  const deck = fakeDeck({ running: [HL2], guideOpensMenu: false, closeCall: false });
  const r = await exitGame(deck.seams);
  assert.equal(r.ok, false);
  assert.match(r.reason ?? "", /Steam's main menu did not open/);
  assert.match(r.reason ?? "", /TerminateApp is not available/);
  assert.match(r.reason ?? "", /still running/);
  assert.deepEqual(deck.running, [HL2]);
  assert.deepEqual(r.running, { appid: 220, name: "Half-Life 2" });
  assert.equal(r.stages.find((s) => s.stage === "close-call")?.ok, false);
  assert.ok(r.checklist?.length);
});

test("the latch thrown during the GUIDE try stops exitGame before the close call", async () => {
  const deck = fakeDeck({
    running: [HL2],
    guideOpensMenu: false,
    onPress: (button) => {
      if (button !== "GUIDE") return;
      fs.mkdirSync(path.dirname(getLatchPath()), { recursive: true });
      fs.writeFileSync(getLatchPath(), JSON.stringify({ at: "now", by: "status-bar", pid: 0, host: "test" }));
    },
  });
  const r = await exitGame(deck.seams);
  assert.equal(r.ok, false);
  assert.equal(r.stopped, true);
  assert.ok(!deck.events.some((e) => e.type === "read-page" && e.what === "TerminateApp"));
  assert.deepEqual(deck.running, [HL2]);
});

// --------------------------------------------------------------------------
// The killswitch, and the evidence file
// --------------------------------------------------------------------------

test("the latch stops a run before its next press", async () => {
  // Thrown by hand right after the GUIDE press lands. The A on Home that
  // would follow must never go out, and the report must say a human stopped
  // it -- not that the bridge broke.
  const deck = fakeDeck({
    onPress: (button) => {
      if (button !== "GUIDE") return;
      fs.mkdirSync(path.dirname(getLatchPath()), { recursive: true });
      fs.writeFileSync(
        getLatchPath(),
        JSON.stringify({ at: "2026-09-02T12:00:00Z", by: "status-bar", pid: 0, host: "test" }),
      );
    },
  });
  const r = await launchGame({ ...deck.seams, name: "Half-Life 2" });
  assert.equal(r.ok, false);
  assert.equal(r.stopped, true);
  assert.match(r.reason ?? "", /Deck automation is STOPPED/);
  assert.match(r.summary, /KILLSWITCH/);
  assert.deepEqual(deck.presses, ["GUIDE"], "the press after the latch was set never went out");
  assert.equal(r.presses, 1);
  assert.deepEqual(stageNames(r), ["read-running", "resolve-app", "open-main-menu"]);
  assert.ok(r.checklist?.length);
});

test("a latch that is already set refuses before the tunnel, with nothing read", async () => {
  fs.mkdirSync(path.dirname(getLatchPath()), { recursive: true });
  fs.writeFileSync(getLatchPath(), JSON.stringify({ at: "now", by: "tool", pid: 0, host: "test" }));
  const deck = fakeDeck({ running: [HL2] });
  const r = await exitGame(deck.seams);
  assert.equal(r.stopped, true);
  assert.equal(r.presses, 0);
  assert.equal(deck.events.length, 0);
});

test("the evidence file holds the stages, what was seen, and RunningApps before and after -- and nothing clock-dependent", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "dps-gamesession-ws-"));
  const previous = process.env.DECKY_STUDIO_WORKSPACE;
  process.env.DECKY_STUDIO_WORKSPACE = workspace;
  try {
    const deck = fakeDeck({ shelf: [HL2.appid] });
    const r = await launchGame({ ...deck.seams, writeEvidence: true, runName: "LAUNCH-GAME-TEST", name: "Half-Life 2" });
    assert.equal(r.ok, true, r.reason);
    assert.equal(r.evidenceFile, path.join(workspace, "runs", "LAUNCH-GAME-TEST.json"));
    const written = JSON.parse(fs.readFileSync(r.evidenceFile!, "utf8"));
    assert.equal(written.tool, "launch-game");
    assert.equal(written.ok, true);
    assert.equal(written.appid, 220);
    assert.deepEqual(written.runningBefore, []);
    assert.deepEqual(written.runningAfter, [HL2]);
    assert.deepEqual(
      written.stages.map((s: { stage: string }) => s.stage),
      stageNames(r),
    );
    assert.deepEqual(written.seen, r.seen);
    // GUIDE, A on Home, A on the tile (already under the ring), A on Play.
    assert.equal(written.presses, 4);
    assert.equal(typeof written.durationMs, "number");
    assert.equal("evidenceFile" in written, false, "the file does not name its own path");
    assert.ok(!JSON.stringify(written).match(/\d{4}-\d{2}-\d{2}T/), "no timestamps in the file");

    const exit = await exitGame({ ...fakeDeck({ running: [HL2] }).seams, writeEvidence: true, runName: "EXIT-GAME-TEST" });
    assert.equal(exit.evidenceFile, path.join(workspace, "runs", "EXIT-GAME-TEST.json"));
    const exitWritten = JSON.parse(fs.readFileSync(exit.evidenceFile!, "utf8"));
    assert.deepEqual(exitWritten.runningBefore, [HL2]);
    assert.deepEqual(exitWritten.runningAfter, []);
  } finally {
    if (previous === undefined) delete process.env.DECKY_STUDIO_WORKSPACE;
    else process.env.DECKY_STUDIO_WORKSPACE = previous;
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("a press the bridge cannot deliver is reported at its stage, not as a miss", async () => {
  const deck = fakeDeck();
  const r = await launchGame({
    ...deck.seams,
    pressFn: async ({ buttons }) => ({
      ok: false,
      reason: "The controller bridge is not available (fake)",
      fidelity: null,
      method: "fake",
      buttons,
      holdMs: 80,
    }),
    name: "Half-Life 2",
  });
  assert.equal(r.ok, false);
  assert.equal(r.stopped, false);
  assert.match(r.reason ?? "", /bridge is not available/);
  assert.match(r.summary, /GUIDE press at open-main-menu could not be delivered/);
  assert.equal(r.presses, 0);
  assert.equal(r.stages[r.stages.length - 1].stage, "open-main-menu");
  assert.equal(r.stages[r.stages.length - 1].ok, false);
});

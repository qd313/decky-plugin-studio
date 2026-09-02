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
import type { RunningApp, LibraryApp, GameSessionOptions } from "./gameSession.js";

const realHome = { USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME };
const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "dps-gamesession-"));
process.env.USERPROFILE = tempHome;
process.env.HOME = tempHome;

const { launchGame, exitGame, resolveApp, refusalLabel, inMainMenu, ownLabelOf } = await import("./gameSession.js");
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
      `div.Panel.Focusable:nth-child(${label === "Home" ? 2 : 1})`,
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

type Screen = "qam" | "game" | "main-menu" | "game-panel" | "modal" | "home" | "app-page";

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
  onPress?: (button: string, count: number) => void;
}

function fakeDeck(spec: DeckSpec = {}) {
  const running: RunningApp[] = [...(spec.running ?? [])];
  const library = spec.library ?? LIBRARY;
  const shelf = spec.shelf ?? [DRG.appid, HL2.appid, BROTATO.appid];
  const nameOf = (id: number): string => library.find((a) => a.appid === id)?.display_name ?? `app ${id}`;
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
  } = {
    screen: spec.screen ?? (running.length ? "game" : "qam"),
    focus: spec.focus ?? (running.length ? NO_RING : QAM_START),
    route: running.length ? "/apprunning" : "/library/home",
    shelfIndex: 0,
    panelIndex: 0,
    appPage: 0,
    /** Set if A ever lands on Install/Update/Buy -- the thing that must never happen. */
    spent: false,
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
        if (b === "GUIDE") {
          st.screen = "main-menu";
          st.focus = running.length ? menuEntry(running[0].display_name) : menuEntry("Home");
        }
        break;
      case "main-menu":
        if (b === "GUIDE") {
          st.screen = running.length ? "game" : "qam";
          st.focus = running.length ? NO_RING : QAM_START;
        } else if (b === "UP") {
          if (label() === "Home" && running.length) st.focus = menuEntry(running[0].display_name);
        } else if (b === "DOWN") {
          if (label() !== "Home") st.focus = menuEntry("Home");
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
      case "home":
        if (b === "RIGHT") {
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

  const seams: GameSessionOptions = {
    pressFn,
    readFocusFn,
    readPageFn,
    sleepFn: async () => {},
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

test("a game that is not on the shelf is refused with the tiles seen and the v1 wording", async () => {
  const deck = fakeDeck({ shelf: [DRG.appid, BROTATO.appid] });
  const r = await launchGame({ ...deck.seams, name: "Half-Life 2" });

  assert.equal(r.ok, false);
  assert.match(r.reason ?? "", /is not on the Recent Games shelf/);
  assert.match(r.reason ?? "", /play it once by hand/);
  assert.match(r.reason ?? "", /Library grid/);
  // Two tiles: one RIGHT reaches the second, the next RIGHT moves nothing, so
  // the walk ends there -- not at the budget of 40.
  assert.deepEqual(deck.presses, ["GUIDE", "A", "RIGHT", "RIGHT"]);
  assert.ok(r.seen.includes("Deep Rock Galactic: Survivor (2321470)"));
  assert.ok(r.seen.includes("Brotato (1942280)"));
  assert.ok(!r.seen.some((s) => s.includes("220")));
  const stage = r.stages.find((s) => s.stage === "find-tile");
  assert.equal(stage?.ok, false);
  assert.match(stage?.detail ?? "", /stopped moving/);
  assert.deepEqual(deck.running, []);
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

test("GUIDE that does not land on the running game's entry is a refusal", async () => {
  // Model a Steam build whose menu opens on Home even with a game up.
  const deck = fakeDeck({ running: [HL2] });
  const seams: GameSessionOptions = {
    ...deck.seams,
    readFocusFn: async (base, timeoutMs) => {
      const r = await deck.seams.readFocusFn!(base, timeoutMs);
      return r.ok && r.gpfocus?.label === "Half-Life 2" ? menuEntry("Home") : r;
    },
  };
  const r = await exitGame(seams);
  assert.equal(r.ok, false);
  assert.match(r.reason ?? "", /did not put the ring on a main-menu entry named "Half-Life 2"/);
  assert.deepEqual(deck.presses, ["GUIDE"]);
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

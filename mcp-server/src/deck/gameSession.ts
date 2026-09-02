/**
 * deck.launchGame / deck.exitGame -- start a game, and stop it again, by
 * pressing the buttons a thumb would press, with every stage verified against a
 * read taken immediately before it.
 *
 * Raised 2026-09-02 during bonsAI's plan 30 spike. A QA row read "LB and RB
 * still switch tabs, with a game running and without", and the rig could do the
 * second half only: a game running is a PRECONDITION several consumer rows need
 * and none could set up, and the draft answer was to ask a human to start one.
 * The maintainer's reply -- "if you can press buttons on a controller, you can
 * press buttons within SteamOS" -- is this file. The design and every device
 * measurement are in docs/planning/07-launch-and-exit-a-game.md; § 6 there is
 * the evidence, and nothing below assumes a state that section did not measure.
 *
 * The same safety model as openPlugin.ts, restated because every A pressed here
 * lands on Steam's OWN UI rather than the plugin's, and the wrong one launches a
 * game, installs one, or buys one:
 *
 *   RULE 1 -- only the D-pad while searching. A and GUIDE are pressed at named
 *   stages only, after a read; B, START and SELECT are never sent at all.
 *
 *   RULE 2 -- A only on a control the read taken immediately before it
 *   identified. For a shelf tile that is the app id in the focused element's
 *   own <img src>, not a substring of its text; for the Play button it is the
 *   exact label "Play". Install, Update, Buy, Pre-load and friends are
 *   refusals, because that press would spend the user's disk or money.
 *
 *   RULE 3 -- one game at a time. launchGame refuses when a different app is in
 *   RunningApps, names it, and points at exitGame. It never launches a second.
 *
 *   RULE 4 -- every stage is bounded and reported, and the killswitch latch is
 *   checked before every press, as in openPlugin.
 *
 *   RULE 5 -- the caller gets the QAM back with deck_openPlugin. These verbs
 *   leave the ring wherever Steam puts it.
 *
 * What is NOT here, on purpose: `steam://rungameid/<id>` over SSH and
 * `SteamClient.Apps.RunAppById` over CDP. Both work and both are driving by
 * script -- a test that starts a game the way no thumb can is not evidence about
 * what a thumb gets (plan 07 § 7). The reads over CDP answer "is it running?"
 * and "which app id is that name?"; they never drive anything.
 */
import fs from "fs";
import path from "path";

import { openCdpTunnel } from "./cdpTunnel.js";
import { pressButton } from "./pressButton.js";
import { readFocusAt, ReadFocusResult } from "./readFocus.js";
import { focusKey, describe, labelIsBorrowed } from "./focusKey.js";
import { automationStopped, stoppedMessage } from "./killswitch.js";
import { readPage, ReadPageOptions, ReadPageResult } from "./readPage.js";
import { getWorkspaceArtifactsDir, timestamp } from "../tools/captureOrchestrator.js";

/**
 * Steam's CEF targets, named as Steam names them (plan 07 § 2). The app lists
 * and the main window's route live in SharedJSContext; the Home screen's shelf
 * is rendered in the Big Picture page.
 */
export const SHARED_JS_CONTEXT = "SharedJSContext";
export const BIG_PICTURE_TARGET = "Steam Big Picture Mode";

export interface RunningApp {
  appid: number;
  display_name: string;
}

export interface LibraryApp extends RunningApp {
  installed: boolean;
}

export interface GameStage {
  stage: string;
  ok: boolean;
  detail: string;
  presses: number;
}

/**
 * In the shape of OpenPluginResult, so the same reader serves both. `running`
 * is what RunningApps said at the END of the run: the launched game, or null
 * after an exit.
 */
export interface GameSessionResult {
  ok: boolean;
  tool: "launch-game" | "exit-game";
  appid: number | null;
  name: string | null;
  /** launchGame only: the game was in RunningApps before anything was pressed. */
  alreadyRunning?: boolean;
  /** exitGame only: RunningApps was empty before anything was pressed. */
  nothingRunning?: boolean;
  running: { appid: number; name: string } | null;
  /** The main window's route after the last stage, when it could be read. */
  route: string | null;
  stages: GameStage[];
  /** Controls the ring was read on, in order -- the useful half of a refusal. */
  seen: string[];
  presses: number;
  fidelity: "steam-routed" | null;
  reason?: string;
  /** True when the run ended because the killswitch was thrown. */
  stopped: boolean;
  /** Present only when the tool could not do it, so a human still can. */
  checklist?: string[];
  evidenceFile: string | null;
  summary: string;
}

export type ReadFocusFn = (base: string, timeoutMs?: number) => Promise<ReadFocusResult>;
export type ReadPageFn = (opts: ReadPageOptions) => Promise<ReadPageResult<unknown>>;

export interface GameSessionOptions {
  /** Serial port of the bridge's COM side. */
  port?: string;
  /** Existing CDP endpoint; omit to open a temporary tunnel for the run. */
  cdpUrl?: string;
  /** How long to wait for RunningApps to change after the final A. Default 60 s. */
  waitMs?: number;
  /** Name for the evidence file under runs/. Defaults to launch-game_<ts> / exit-game_<ts>. */
  runName?: string;
  /** Set false to skip the evidence file. Default true. */
  writeEvidence?: boolean;
  /**
   * Test-only seams, the same justification as openPlugin's pressFn: the
   * suite's hardware guard refuses real presses, so without them every
   * navigation test collapses to "no press could be delivered" and cannot tell
   * a tool that pressed A after reading "Play" from one that pressed A after
   * reading "Install" -- which is the whole of rule 2. Production code and the
   * MCP dispatch never set any of them.
   */
  pressFn?: typeof pressButton;
  readFocusFn?: ReadFocusFn;
  readPageFn?: ReadPageFn;
  sleepFn?: (ms: number) => Promise<void>;
}

export interface LaunchGameOptions extends GameSessionOptions {
  /** Library display name; exact (case-insensitive) first, then a unique contains. */
  name?: string;
  /** Steam app id. Exactly one of name / appid is required. */
  appid?: number;
  /** Max RIGHT presses along the Recent Games shelf. Default 40. */
  budget?: number;
}

export type ExitGameOptions = GameSessionOptions;

type Direction = "UP" | "DOWN" | "LEFT" | "RIGHT";
type Button = Direction | "A" | "GUIDE";

/** The main menu's container, in every selector the ring reported from it (plan 07 § 6). */
const MAIN_MENU_CONTAINER = "#MainNavMenuContainer";
const HOME_LABEL = "Home";
const PLAY_LABEL = "Play";
const CONFIRM_LABEL = "Confirm";
/** Lower-case g, as measured; "Exit Game" would not match and must not. */
const EXIT_GAME_LABEL = "Exit game";
/** The control after the shelf's last tile. */
const SHELF_END_LABEL = "View more in your Library";
/** Measured RIGHT from the game's menu entry lands here; informational only. */
const RESUME_LABEL = "Resume game";

/**
 * Labels the app page's primary control carries when A would spend disk or
 * money (rule 2). Matched as a case-insensitive prefix, so "Buy Half-Life 2"
 * and "Update" both refuse; refusing one label too many costs a run, accepting
 * one too few costs the user.
 */
const REFUSAL_LABELS = [
  "Install",
  "Update",
  "Buy",
  "Pre-load",
  "Pre-purchase",
  "Purchase",
  "Add to Cart",
  "Download",
];

/** Settles, from plan 07 § 6. */
const MENU_SETTLE_MS = 800; // the main menu was read 67% visible while still sliding in
const PAGE_SETTLE_MS = 1600; // A on Home, on a tile and on Exit game each settled in ~1.6 s
const DPAD_SETTLE_MS = 250;
const POLL_MS = 1000;
const HOME_BUDGET = 8;
const PLAY_BUDGET = 10;
const EXIT_BUDGET = 10;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Thrown from the one helper every press in this file goes through, so a stop
 * unwinds the whole staged sequence at once -- the same shape as openPlugin.
 */
class AutomationStoppedError extends Error {}

/** A press the bridge could not deliver. Carries the stage so the report can say where. */
class PressFailedError extends Error {
  constructor(
    readonly stage: string,
    readonly button: Button,
    reason: string,
  ) {
    super(reason);
  }
}

// ---------------------------------------------------------------------------
// Page expressions. Read-only, every one of them: they run inside Steam and
// answer a question. The IIFE-with-try shape is what readPage asks for.
// ---------------------------------------------------------------------------

const RUNNING_APPS_EXPR =
  "(() => { try { var a = window.SteamUIStore.RunningApps || []; var out = []; " +
  "for (var i = 0; i < a.length; i++) out.push({ appid: Number(a[i].appid), display_name: String(a[i].display_name || '') }); " +
  "return out; } catch (e) { return { error: String(e) }; } })()";

const ALL_APPS_EXPR =
  "(() => { try { var a = window.collectionStore.allAppsCollection.allApps || []; var out = []; " +
  "for (var i = 0; i < a.length; i++) out.push({ appid: Number(a[i].appid), display_name: String(a[i].display_name || ''), installed: !!a[i].installed }); " +
  "return out; } catch (e) { return { error: String(e) }; } })()";

/**
 * Better than the target's URL (plan 07 § 6): the main window's route, read
 * directly. `/library/home` on the Home screen, `/apprunning` with a game up,
 * `/library/app/<appid>` on an app page.
 */
const ROUTE_EXPR =
  "(() => { try { var p = window.SteamUIStore.WindowStore.GamepadUIMainWindowInstance.m_history.location.pathname; " +
  "return typeof p === 'string' ? p : null; } catch (e) { return null; } })()";

/**
 * The app id under the ring, from the focused tile's own image.
 *
 * A shelf tile holds an <img> whose src carries the id -- `/assets/550/...` for
 * a local asset, `.../apps/2321470/...` for a store one (plan 07 § 2) -- and
 * that is the exact check rule 2 wants; the tile's text is the name twice plus
 * a playtime and is recorded, not trusted. The climb through ancestors is for a
 * ring that lands on an inner element of the tile. It is guarded: an ancestor
 * whose images name MORE than one app is the shelf itself, not a tile, and
 * naming the shelf's first image as "the focused tile" would press A on the
 * wrong game. That ancestor ends the climb with no id rather than a guess.
 */
const TILE_EXPR =
  "(() => { try { var el = document.querySelector('.gpfocus'); " +
  "if (!el) return { ok: false, reason: 'no .gpfocus in this document' }; " +
  "var RX = /\\/(?:assets|apps)\\/(\\d+)\\//; var text = (el.textContent || '').trim().slice(0, 80); " +
  "var n = el; for (var depth = 0; depth <= 8 && n; depth++) { " +
  "var imgs = n.querySelectorAll ? n.querySelectorAll('img') : []; var ids = []; var src = null; " +
  "for (var i = 0; i < imgs.length; i++) { var s = imgs[i].getAttribute('src') || imgs[i].src || ''; var m = RX.exec(s); " +
  "if (!m) continue; if (ids.indexOf(m[1]) < 0) { ids.push(m[1]); if (src === null) src = s.slice(0, 160); } } " +
  "if (ids.length === 1) return { ok: true, appid: Number(ids[0]), depth: depth, src: src, text: text }; " +
  "if (ids.length > 1) return { ok: true, appid: null, depth: depth, ambiguous: ids.length, text: text }; " +
  "n = n.parentElement; } " +
  "return { ok: true, appid: null, text: text }; } catch (e) { return { ok: false, reason: String(e) }; } })()";

export interface TileRead {
  /** False when the Big Picture page had no ring, or could not be asked. */
  ok: boolean;
  appid: number | null;
  /** How many parents up the identifying image was found; 0 is the focused element itself. */
  depth: number | null;
  src: string | null;
  text: string;
  reason?: string;
}

// ---------------------------------------------------------------------------
// Pure helpers, exported for the tests and for openPlugin's confirming read.
// ---------------------------------------------------------------------------

function parseRunning(value: unknown): RunningApp[] | null {
  if (!Array.isArray(value)) return null;
  const out: RunningApp[] = [];
  for (const v of value) {
    if (!v || typeof v !== "object") continue;
    const appid = Number((v as { appid?: unknown }).appid);
    if (!Number.isFinite(appid)) continue;
    out.push({ appid, display_name: String((v as { display_name?: unknown }).display_name ?? "") });
  }
  return out;
}

function parseLibrary(value: unknown): LibraryApp[] | null {
  if (!Array.isArray(value)) return null;
  const out: LibraryApp[] = [];
  for (const v of value) {
    if (!v || typeof v !== "object") continue;
    const appid = Number((v as { appid?: unknown }).appid);
    if (!Number.isFinite(appid)) continue;
    out.push({
      appid,
      display_name: String((v as { display_name?: unknown }).display_name ?? ""),
      installed: Boolean((v as { installed?: unknown }).installed),
    });
  }
  return out;
}

function readFailure(r: ReadPageResult<unknown>, what: string): string {
  if (!r.ok) return r.reason ?? `${what} could not be read`;
  const err = (r.value as { error?: unknown } | null)?.error;
  return err ? `${what} threw in the page: ${String(err)}` : `${what} did not return a list`;
}

/**
 * `window.SteamUIStore.RunningApps`, read from SharedJSContext. The launch
 * signal and the exit signal both come from here (plan 07 § 6: the app id
 * appears under a second after A on Play, before the game's own window is
 * up; it stays while the exit dialog is open). Shared with openPlugin, which
 * reads it as the confirming signal for "a game owns input".
 */
export async function readRunningApps(
  cdpBase: string,
  readPageFn: ReadPageFn = readPage,
): Promise<{ ok: boolean; apps: RunningApp[]; reason?: string }> {
  const r = await readPageFn({
    expression: RUNNING_APPS_EXPR,
    target: SHARED_JS_CONTEXT,
    cdpUrl: cdpBase,
    timeoutMs: 10_000,
  });
  const apps = r.ok ? parseRunning(r.value) : null;
  if (!apps) return { ok: false, apps: [], reason: readFailure(r, "SteamUIStore.RunningApps") };
  return { ok: true, apps };
}

export async function readAllApps(
  cdpBase: string,
  readPageFn: ReadPageFn = readPage,
): Promise<{ ok: boolean; apps: LibraryApp[]; reason?: string }> {
  const r = await readPageFn({
    expression: ALL_APPS_EXPR,
    target: SHARED_JS_CONTEXT,
    cdpUrl: cdpBase,
    timeoutMs: 10_000,
  });
  const apps = r.ok ? parseLibrary(r.value) : null;
  if (!apps) return { ok: false, apps: [], reason: readFailure(r, "collectionStore.allAppsCollection.allApps") };
  return { ok: true, apps };
}

export async function readRoute(cdpBase: string, readPageFn: ReadPageFn = readPage): Promise<string | null> {
  const r = await readPageFn({
    expression: ROUTE_EXPR,
    target: SHARED_JS_CONTEXT,
    cdpUrl: cdpBase,
    timeoutMs: 10_000,
  });
  return r.ok && typeof r.value === "string" ? r.value : null;
}

export async function readFocusedTile(cdpBase: string, readPageFn: ReadPageFn = readPage): Promise<TileRead> {
  const r = await readPageFn({
    expression: TILE_EXPR,
    target: BIG_PICTURE_TARGET,
    cdpUrl: cdpBase,
    timeoutMs: 10_000,
  });
  const v = (r.ok ? r.value : null) as Partial<TileRead> | null;
  if (!v || typeof v !== "object") {
    return { ok: false, appid: null, depth: null, src: null, text: "", reason: r.reason ?? "no value" };
  }
  const appid = Number(v.appid);
  return {
    ok: v.ok === true,
    appid: Number.isFinite(appid) && v.appid !== null && v.appid !== undefined ? appid : null,
    depth: typeof v.depth === "number" ? v.depth : null,
    src: typeof v.src === "string" ? v.src : null,
    text: typeof v.text === "string" ? v.text : "",
    reason: typeof v.reason === "string" ? v.reason : undefined,
  };
}

/**
 * Which library entry a caller means. Exact name first, then a unique
 * contains; anything ambiguous is a refusal that lists the candidates, because
 * two non-Steam shortcuts can share a display name exactly (the maintainer's
 * Deck has "007 - GoldenEye" twice) and "which one" is not the rig's call.
 */
export function resolveApp(
  apps: LibraryApp[],
  name: string,
  appid: number | null,
): { app: LibraryApp } | { reason: string } {
  const list = (hits: LibraryApp[]): string =>
    hits
      .slice(0, 8)
      .map((a) => `${a.display_name} (${a.appid}${a.installed ? "" : ", not installed"})`)
      .join(", ") + (hits.length > 8 ? `, and ${hits.length - 8} more` : "");

  if (appid !== null) {
    const hit = apps.find((a) => a.appid === appid);
    return hit ? { app: hit } : { reason: `appid ${appid} is not in the library (allApps lists ${apps.length} apps)` };
  }
  const want = name.trim().toLowerCase();
  const exact = apps.filter((a) => a.display_name.trim().toLowerCase() === want);
  if (exact.length === 1) return { app: exact[0] };
  if (exact.length > 1) {
    return { reason: `"${name}" names ${exact.length} apps exactly: ${list(exact)} - pass appid instead` };
  }
  const partial = apps.filter((a) => a.display_name.toLowerCase().includes(want));
  if (partial.length === 1) return { app: partial[0] };
  if (partial.length > 1) {
    return { reason: `"${name}" matches ${partial.length} apps: ${list(partial)} - use the full name, or pass appid` };
  }
  return { reason: `no app in the library is called "${name}" (allApps lists ${apps.length} apps)` };
}

/**
 * The focused control's OWN name, never a borrowed one -- openPlugin's rule,
 * for the same reason: an A press is authorised by what the ring's element is
 * called, and an ancestor's text says what the ring is INSIDE. Every control
 * this file presses A on was measured carrying its own name (plan 07 § 6:
 * <DIV> "Home", <DIV> "Play", <DIV> "Exit game", <BUTTON> "Confirm"), so a
 * borrowed one here is a sign the ring is somewhere else.
 */
export function ownLabelOf(r: ReadFocusResult | null): string {
  const el = r?.gpfocus;
  if (!el) return "";
  if (labelIsBorrowed(el)) return "";
  if (el.label !== undefined) return el.label.trim();
  return (el.ariaLabel || el.text || "").trim();
}

/**
 * Is the ring in Steam's main menu -- the menu column or the game panel beside
 * it? Both live under #MainNavMenuContainer in every selector measured
 * (plan 07 § 6), the menu is its own CEF page (MainMenu_uid2), and with no game
 * up the ring lands on "Home".
 */
export function inMainMenu(r: ReadFocusResult | null): boolean {
  if (!r?.ok || !r.gpfocus) return false;
  if ((r.gpfocus.selector ?? "").includes(MAIN_MENU_CONTAINER)) return true;
  if (
    r.gpfocusWithin.some(
      (w) => (w.selector ?? "").includes(MAIN_MENU_CONTAINER) || w.id === MAIN_MENU_CONTAINER.slice(1),
    )
  ) {
    return true;
  }
  if ((r.target?.title ?? "").toLowerCase().includes("mainmenu")) return true;
  return ownLabelOf(r) === HOME_LABEL;
}

/** The refusal word a label starts with, or null when it is safe to consider. */
export function refusalLabel(label: string): string | null {
  const l = label.trim().toLowerCase();
  if (!l) return null;
  return REFUSAL_LABELS.find((w) => l.startsWith(w.toLowerCase())) ?? null;
}

function sameName(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** The main menu's game entry is labelled with the display name; equal or containing it counts. */
function namesGame(label: string, displayName: string): boolean {
  const l = label.trim().toLowerCase();
  const n = displayName.trim().toLowerCase();
  return n.length > 0 && l.length > 0 && (l === n || l.includes(n));
}

function nameOf(a: RunningApp): string {
  return `"${a.display_name}" (appid ${a.appid})`;
}

const LAUNCH_CHECKLIST = (name: string): string[] => [
  "On the Deck, press the Steam button and choose Home",
  `Find "${name}" on the Recent Games shelf (or in the Library) and press A`,
  'Press A on "Play" - not on Install, Update or Buy',
  "Then reopen the plugin with deck_openPlugin",
];

const EXIT_CHECKLIST = (name: string): string[] => [
  `On the Deck, press the Steam button; the main menu opens on "${name}"'s entry`,
  'Press Right, then Down to "Exit game", then A',
  'Press A on "Confirm"',
  "Then reopen the plugin with deck_openPlugin",
];

// ---------------------------------------------------------------------------
// The rig: one tunnel, one press gate, one place stages are recorded.
// ---------------------------------------------------------------------------

class Rig {
  readonly stages: GameStage[] = [];
  readonly seen: string[] = [];
  presses = 0;
  runningBefore: RunningApp[] | null = null;
  runningAfter: RunningApp[] | null = null;

  constructor(
    private readonly base: string,
    private readonly opts: GameSessionOptions,
  ) {}

  /** Every press in this file, D-pad or otherwise, passes through this first. */
  abortIfStopped(): void {
    const rec = automationStopped();
    if (rec) throw new AutomationStoppedError(stoppedMessage(rec));
  }

  /**
   * The one gate. `stage` names where a refused press is reported. A and GUIDE
   * are accepted here only because the callers below press them at named
   * stages after a read; there is no call site for B, START or SELECT.
   */
  async press(button: Button, stage: string): Promise<void> {
    this.abortIfStopped();
    const press = this.opts.pressFn ?? pressButton;
    const p = await press({ buttons: [button], port: this.opts.port });
    if (!p.ok) throw new PressFailedError(stage, button, p.reason ?? "press failed");
    this.presses++;
  }

  sleep(ms: number): Promise<void> {
    return (this.opts.sleepFn ?? sleep)(ms);
  }

  readFocus(): Promise<ReadFocusResult> {
    const read = this.opts.readFocusFn ?? ((base, timeoutMs) => readFocusAt(base, timeoutMs));
    return read(this.base, 10_000);
  }

  readRunning(): Promise<{ ok: boolean; apps: RunningApp[]; reason?: string }> {
    return readRunningApps(this.base, this.opts.readPageFn);
  }

  readLibrary(): Promise<{ ok: boolean; apps: LibraryApp[]; reason?: string }> {
    return readAllApps(this.base, this.opts.readPageFn);
  }

  readRoute(): Promise<string | null> {
    return readRoute(this.base, this.opts.readPageFn);
  }

  readTile(): Promise<TileRead> {
    return readFocusedTile(this.base, this.opts.readPageFn);
  }

  stage(stage: string, ok: boolean, detail: string, presses: number): void {
    this.stages.push({ stage, ok, detail, presses });
  }

  record(label: string): void {
    const l = label.trim();
    if (l && !this.seen.includes(l)) this.seen.push(l);
  }

  /** RULE 1: a D-pad press, a settle, a fresh read. Never A. Recording is the caller's. */
  async nudge(dir: Direction, stage: string): Promise<ReadFocusResult> {
    await this.press(dir, stage);
    await this.sleep(DPAD_SETTLE_MS);
    return this.readFocus();
  }

  /**
   * Walk one direction until `done` holds, or the budget is spent, or the ring
   * stops producing new elements -- a menu dead-ends rather than wraps, and
   * spending the rest of a budget on a stationary ring learns nothing.
   */
  async walk(
    dir: Direction,
    budget: number,
    stage: string,
    start: ReadFocusResult,
    done: (r: ReadFocusResult) => boolean,
  ): Promise<{ found: boolean; focus: ReadFocusResult; presses: number; ended: string }> {
    let focus = start;
    let presses = 0;
    const keys = new Set<string>([focusKey(focus) ?? ""]);
    for (;;) {
      if (done(focus)) return { found: true, focus, presses, ended: "found" };
      if (presses >= budget) return { found: false, focus, presses, ended: `budget of ${budget} spent` };
      focus = await this.nudge(dir, stage);
      presses++;
      if (!focus.ok) return { found: false, focus, presses, ended: "the ring became unreadable" };
      this.record(ownLabelOf(focus));
      const k = focusKey(focus) ?? "";
      if (keys.has(k)) {
        // One more chance for the predicate: the repeat may BE the target.
        if (done(focus)) return { found: true, focus, presses, ended: "found" };
        return { found: false, focus, presses, ended: "the ring stopped moving" };
      }
      keys.add(k);
    }
  }

  /** Poll RunningApps until `done` holds. A timeout is a finding, not an error. */
  async waitForRunning(
    done: (apps: RunningApp[]) => boolean,
    waitMs: number,
  ): Promise<{ satisfied: boolean; apps: RunningApp[] | null; waitedMs: number; polls: number; reason?: string }> {
    const started = Date.now();
    let polls = 0;
    let last: RunningApp[] | null = null;
    let reason: string | undefined;
    for (;;) {
      const r = await this.readRunning();
      polls++;
      if (r.ok) {
        last = r.apps;
        if (done(r.apps)) return { satisfied: true, apps: last, waitedMs: Date.now() - started, polls };
      } else {
        reason = r.reason;
      }
      if (Date.now() - started >= waitMs) {
        return { satisfied: false, apps: last, waitedMs: Date.now() - started, polls, reason };
      }
      await this.sleep(POLL_MS);
    }
  }
}

/** What a verb's body decides; the session wrapper turns it into the result. */
interface Outcome {
  ok: boolean;
  appid: number | null;
  name: string | null;
  alreadyRunning?: boolean;
  nothingRunning?: boolean;
  running: { appid: number; name: string } | null;
  route: string | null;
  reason?: string;
  summary: string;
}

function stagesLine(stages: GameStage[]): string {
  return stages.map((s) => `${s.stage} ${s.ok ? "ok" : "failed"}`).join(", ") || "none";
}

/**
 * Everything the two verbs share: the latch check before the tunnel, the
 * tunnel, the conversion of a stop or a refused press into a result, and the
 * evidence file. The body does the driving and returns what it decided.
 */
async function runSession(
  tool: GameSessionResult["tool"],
  opts: GameSessionOptions,
  checklistFor: (name: string | null) => string[],
  asked: string | null,
  body: (rig: Rig) => Promise<Outcome>,
): Promise<GameSessionResult> {
  const started = Date.now();

  const blank: GameSessionResult = {
    ok: false,
    tool,
    appid: null,
    name: asked,
    running: null,
    route: null,
    stages: [],
    seen: [],
    presses: 0,
    fidelity: null,
    stopped: false,
    evidenceFile: null,
    summary: "",
  };

  // Before the tunnel: a stopped rig should not spend SSH setup on a run that
  // cannot deliver its first press.
  const latched = automationStopped();
  if (latched) {
    return {
      ...blank,
      stopped: true,
      reason: stoppedMessage(latched),
      checklist: checklistFor(asked),
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
        ...blank,
        reason: (err as Error).message,
        checklist: checklistFor(asked),
        stages: [{ stage: "connect", ok: false, detail: (err as Error).message, presses: 0 }],
        summary: "could not reach the Deck, so nothing was pressed - follow the checklist by hand",
      };
    }
  }

  const rig = new Rig(cdpBase, opts);
  let result: GameSessionResult;
  try {
    const out = await body(rig);
    result = {
      ...blank,
      ...out,
      stages: rig.stages,
      seen: rig.seen,
      presses: rig.presses,
      fidelity: rig.presses > 0 ? "steam-routed" : null,
      stopped: false,
      ...(out.ok ? {} : { checklist: checklistFor(out.name ?? asked) }),
    };
  } catch (err) {
    const stopped = err instanceof AutomationStoppedError;
    if (err instanceof PressFailedError) {
      rig.stage(err.stage, false, `${err.button} could not be delivered: ${err.message}`, 0);
    }
    result = {
      ...blank,
      stages: rig.stages,
      seen: rig.seen,
      presses: rig.presses,
      fidelity: rig.presses > 0 ? "steam-routed" : null,
      stopped,
      reason: (err as Error).message,
      checklist: checklistFor(asked),
      summary: stopped
        ? `KILLSWITCH: stopped by hand after ${rig.presses} press(es) and ${rig.stages.length} stage(s) ` +
          `(${rig.stages.map((s) => s.stage).join(", ") || "none"})`
        : err instanceof PressFailedError
          ? `the ${err.button} press at ${err.stage} could not be delivered after ${rig.presses} press(es)`
          : `stopped after ${rig.stages.length} stage(s): ${(err as Error).message}`,
    };
  } finally {
    closeTunnel?.();
  }

  if (opts.writeEvidence !== false) {
    try {
      const dir = getWorkspaceArtifactsDir("runs");
      const name = (opts.runName ?? `${tool}_${timestamp()}`).replace(/[^A-Za-z0-9._-]/g, "_");
      const file = path.join(dir, `${name}.json`);
      // Stages, what was seen, the RunningApps reads before and after, and the
      // durations. Nothing else clock-dependent, and not the file's own path.
      const evidence = {
        tool,
        ok: result.ok,
        reason: result.reason ?? null,
        stopped: result.stopped,
        appid: result.appid,
        name: result.name,
        alreadyRunning: result.alreadyRunning ?? false,
        nothingRunning: result.nothingRunning ?? false,
        running: result.running,
        route: result.route,
        stages: result.stages,
        seen: result.seen,
        presses: result.presses,
        fidelity: result.fidelity,
        runningBefore: rig.runningBefore,
        runningAfter: rig.runningAfter,
        durationMs: Date.now() - started,
        summary: result.summary,
      };
      fs.writeFileSync(file, JSON.stringify(evidence, null, 2) + "\n", "utf8");
      result.evidenceFile = file;
    } catch (err) {
      // A run that produced findings must not be thrown away because the log
      // could not be written. Say so and hand back the findings anyway.
      result.summary += `; evidence file could not be written (${(err as Error).message})`;
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// deck.launchGame
// ---------------------------------------------------------------------------

export async function launchGame(opts: LaunchGameOptions): Promise<GameSessionResult> {
  const wantName = (opts.name ?? "").trim();
  const wantAppid = opts.appid != null && Number.isFinite(Number(opts.appid)) ? Number(opts.appid) : null;
  const budget = Math.max(0, opts.budget ?? 40);
  const waitMs = opts.waitMs ?? 60_000;
  const asked = wantName || (wantAppid !== null ? `appid ${wantAppid}` : null);

  // Exactly one of the two. There is deliberately no "launch whatever is
  // first" -- a verb that presses A on Steam's own UI must be told what for.
  if ((wantName && wantAppid !== null) || (!wantName && wantAppid === null)) {
    return {
      ok: false,
      tool: "launch-game",
      appid: wantAppid,
      name: wantName || null,
      running: null,
      route: null,
      stages: [],
      seen: [],
      presses: 0,
      fidelity: null,
      stopped: false,
      reason:
        "exactly one of name or appid is required - there is deliberately no \"launch whatever is first\", " +
        "and both at once would need the rig to decide which wins",
      checklist: LAUNCH_CHECKLIST(asked ?? "the game"),
      evidenceFile: null,
      summary: "refused: nothing identified the game, so nothing was pressed",
    };
  }

  return runSession("launch-game", opts, (n) => LAUNCH_CHECKLIST(n ?? asked ?? "the game"), asked, async (rig) => {
    const refuse = (reason: string, summary: string, appid: number | null, name: string | null): Outcome => ({
      ok: false,
      appid,
      name,
      running: null,
      route: null,
      reason,
      summary,
    });

    // ---- read-running: 0 presses --------------------------------------------
    const before = await rig.readRunning();
    rig.runningBefore = before.ok ? before.apps : null;
    if (!before.ok) {
      rig.stage("read-running", false, before.reason ?? "RunningApps unreadable", 0);
      return refuse(
        `could not read window.SteamUIStore.RunningApps in ${SHARED_JS_CONTEXT}: ${before.reason}`,
        "could not read Steam's running-app list, so nothing was pressed",
        wantAppid,
        wantName || null,
      );
    }

    const runningTarget = before.apps.find((a) =>
      wantAppid !== null ? a.appid === wantAppid : sameName(a.display_name, wantName),
    );
    if (runningTarget) {
      rig.stage("read-running", true, `${nameOf(runningTarget)} is already in RunningApps`, 0);
      rig.runningAfter = before.apps;
      return {
        ok: true,
        appid: runningTarget.appid,
        name: runningTarget.display_name,
        alreadyRunning: true,
        running: { appid: runningTarget.appid, name: runningTarget.display_name },
        route: await rig.readRoute(),
        summary: `${nameOf(runningTarget)} was already running - nothing was pressed`,
      };
    }

    // RULE 3. Names it, points at the exit verb, and never launches a second.
    if (before.apps.length > 0) {
      const names = before.apps.map(nameOf).join(", ");
      const looksLikeIt =
        wantName && before.apps.find((a) => a.display_name.toLowerCase().includes(wantName.toLowerCase()));
      rig.stage("read-running", false, `${names} already running`, 0);
      return refuse(
        `${names} is already running, and deck_launchGame never launches a second game (rule 3). ` +
          "Exit it first with deck_exitGame." +
          (looksLikeIt
            ? ` "${wantName}" is not an exact match for it; pass appid ${looksLikeIt.appid} if that is the game you mean.`
            : ""),
        `refused: ${names} is running - nothing was pressed`,
        wantAppid,
        wantName || null,
      );
    }
    rig.stage("read-running", true, "RunningApps is empty", 0);

    // ---- resolve-app: 0 presses ---------------------------------------------
    const lib = await rig.readLibrary();
    if (!lib.ok) {
      rig.stage("resolve-app", false, lib.reason ?? "allApps unreadable", 0);
      return refuse(
        `could not read the library in ${SHARED_JS_CONTEXT}: ${lib.reason}`,
        "could not read Steam's app list, so nothing was pressed",
        wantAppid,
        wantName || null,
      );
    }
    const resolved = resolveApp(lib.apps, wantName, wantAppid);
    if ("reason" in resolved) {
      rig.stage("resolve-app", false, resolved.reason, 0);
      return refuse(resolved.reason, "refused: could not identify one installed game - nothing was pressed", wantAppid, wantName || null);
    }
    const target = resolved.app;
    const name = target.display_name;
    if (!target.installed) {
      rig.stage("resolve-app", false, `${nameOf(target)} is not installed`, 0);
      return refuse(
        `${nameOf(target)} is not installed. Pressing Play on it would start an install, which spends disk (rule 2); ` +
          "install it by hand first",
        "refused: the game is not installed - nothing was pressed",
        target.appid,
        name,
      );
    }
    rig.stage("resolve-app", true, `${nameOf(target)} is in the library and installed`, 0);
    const libraryNames = new Map(lib.apps.map((a) => [a.appid, a.display_name]));

    // ---- open-main-menu: 1 GUIDE ---------------------------------------------
    //
    // Measured (plan 07 § 6): one bare GUIDE, with the QAM open and the ring on
    // Decky's Back button, closes the QAM and opens the main menu with the ring
    // on "Home" -- no B presses needed. It is a BARE press: GUIDE and A together
    // would be read the same way, and hold-then-tap is the QAM toggle, which is
    // the opposite of what this stage wants.
    let focus = await rig.readFocus();
    rig.record(ownLabelOf(focus));
    const from = focus.ok
      ? `ring on ${describe(focus)}` +
        (focus.visibleQuickAccessTab !== null ? ` with QAM pane ${focus.visibleQuickAccessTab} on screen` : "")
      : "no ring readable";
    if (inMainMenu(focus)) {
      // GUIDE is a toggle: from inside the menu it would close it.
      rig.stage("open-main-menu", true, `main menu already open (${from}), so GUIDE was not pressed`, 0);
    } else {
      await rig.press("GUIDE", "open-main-menu");
      await rig.sleep(MENU_SETTLE_MS);
      focus = await rig.readFocus();
      rig.record(ownLabelOf(focus));
      const opened = inMainMenu(focus);
      rig.stage(
        "open-main-menu",
        opened,
        opened
          ? `one GUIDE press from ${from}; ring on ${describe(focus)} in the main menu`
          : `one GUIDE press from ${from}; ring on ${describe(focus)}, which is not the main menu`,
        1,
      );
      if (!opened) {
        return refuse(
          `GUIDE did not put the ring in Steam's main menu (${MAIN_MENU_CONTAINER}); it is on ${describe(focus)}`,
          "the main menu did not open where a read could see it - nothing else was pressed",
          target.appid,
          name,
        );
      }
    }

    // ---- go-home: <= 8 UP, then 1 A ------------------------------------------
    let homeWalk = 0;
    if (ownLabelOf(focus) !== HOME_LABEL) {
      const w = await rig.walk("UP", HOME_BUDGET, "go-home", focus, (r) => ownLabelOf(r) === HOME_LABEL);
      focus = w.focus;
      homeWalk = w.presses;
      if (!w.found) {
        rig.stage("go-home", false, `no entry labelled exactly "Home" within ${w.presses} UP press(es); ${w.ended}`, w.presses);
        return refuse(
          `could not find "Home" in the main menu (${w.ended}); saw ${rig.seen.join(", ") || "nothing labelled"}`,
          "walked the main menu without finding Home - A was not pressed",
          target.appid,
          name,
        );
      }
    }
    // The read that authorises this A is the one that saw "Home". Nothing has
    // been pressed since. Measured: the ring lands on the shelf's first tile,
    // the route reads /library/home, ~1.6 s.
    await rig.press("A", "go-home");
    await rig.sleep(PAGE_SETTLE_MS);
    focus = await rig.readFocus();
    let route = await rig.readRoute();
    const onHome = route !== null && /\/library\/home\/?$/.test(route);
    rig.stage(
      "go-home",
      onHome,
      onHome
        ? `A on "Home" after ${homeWalk} UP press(es); route ${route}, ring on ${describe(focus)}`
        : `A on "Home" after ${homeWalk} UP press(es); route ${route ?? "unreadable"}, expected /library/home`,
      homeWalk + 1,
    );
    if (!onHome) {
      return refuse(
        `A on "Home" did not land on /library/home (route ${route ?? "unreadable"})`,
        "the Home screen could not be confirmed by its route - nothing else was pressed",
        target.appid,
        name,
      );
    }

    // ---- find-tile: <= budget RIGHT ------------------------------------------
    //
    // At every stop the focused element's own image names the app; the text is
    // recorded, not trusted (rule 2). The walk ends at the target, at the
    // budget, at "View more in your Library", or when the ring stops producing
    // new elements -- the end of the shelf.
    let shelfPresses = 0;
    let found = false;
    let ended = "";
    let tile: TileRead = { ok: false, appid: null, depth: null, src: null, text: "" };
    const keys = new Set<string>([focusKey(focus) ?? ""]);
    for (;;) {
      tile = await rig.readTile();
      if (!tile.ok) {
        ended = `the ${BIG_PICTURE_TARGET} page could not name the focused tile (${tile.reason ?? "no reason"})`;
        break;
      }
      rig.record(
        tile.appid !== null
          ? `${libraryNames.get(tile.appid) ?? tile.text ?? "unnamed tile"} (${tile.appid})`
          : ownLabelOf(focus) || tile.text,
      );
      if (tile.appid === target.appid) {
        found = true;
        break;
      }
      if (ownLabelOf(focus) === SHELF_END_LABEL) {
        ended = `reached "${SHELF_END_LABEL}", the end of the shelf`;
        break;
      }
      if (shelfPresses >= budget) {
        ended = `budget of ${budget} RIGHT presses spent`;
        break;
      }
      focus = await rig.nudge("RIGHT", "find-tile");
      shelfPresses++;
      if (!focus.ok) {
        ended = "the ring became unreadable";
        break;
      }
      const k = focusKey(focus) ?? "";
      if (keys.has(k)) {
        ended = "the ring stopped moving - the end of the shelf";
        break;
      }
      keys.add(k);
    }
    rig.stage(
      "find-tile",
      found,
      found
        ? `appid ${target.appid} in the focused tile's own image (${tile.src ?? "?"}, ${tile.depth ?? 0} level(s) up) ` +
          `after ${shelfPresses} RIGHT press(es)`
        : `walked ${shelfPresses} RIGHT press(es) without a tile for appid ${target.appid}; ${ended}`,
      shelfPresses,
    );
    if (!found) {
      return refuse(
        `${nameOf(target)} is not on the Recent Games shelf (${ended}; saw ${rig.seen.join(", ") || "nothing"}). ` +
          "In v1 that is a refusal: play it once by hand so it appears there, or extend find-tile to the " +
          "Library grid (plan 07 § 8)",
        `walked the shelf ${shelfPresses} press(es) without finding "${name}" - A was not pressed`,
        target.appid,
        name,
      );
    }

    // ---- open-app-page: 1 A, then <= 10 DOWN ---------------------------------
    //
    // The read that authorises this A is the tile read above: the app id in the
    // focused element's own <img src>. Measured: the ring lands directly on a
    // <DIV> labelled "Play", ~1.6 s. The app page's route was not measured, so
    // it is reported here and not gated on.
    await rig.press("A", "open-app-page");
    await rig.sleep(PAGE_SETTLE_MS);
    focus = await rig.readFocus();
    rig.record(ownLabelOf(focus));
    let label = ownLabelOf(focus);
    let playWalk = 0;
    const isPlay = (r: ReadFocusResult): boolean => ownLabelOf(r) === PLAY_LABEL;
    const isRefusal = (r: ReadFocusResult): boolean => refusalLabel(ownLabelOf(r)) !== null;
    if (label !== PLAY_LABEL && !isRefusal(focus)) {
      const w = await rig.walk("DOWN", PLAY_BUDGET, "open-app-page", focus, (r) => isPlay(r) || isRefusal(r));
      focus = w.focus;
      playWalk = w.presses;
      label = ownLabelOf(focus);
    }
    const refused = refusalLabel(label);
    if (refused) {
      rig.stage(
        "open-app-page",
        false,
        `the app page's control reads "${label}", not "Play" - A here would spend disk or money (rule 2)`,
        1 + playWalk,
      );
      return refuse(
        `${nameOf(target)}'s page shows "${label}" instead of "Play": pressing it would ${
          refused.toLowerCase() === "update" ? "start an update" : "install or buy the game"
        }, which the rig never does (rule 2). Do that by hand, then call again`,
        `the app page offered "${label}", not Play - A was not pressed`,
        target.appid,
        name,
      );
    }
    if (label !== PLAY_LABEL) {
      rig.stage("open-app-page", false, `no control labelled exactly "Play" within ${playWalk} DOWN press(es)`, 1 + playWalk);
      return refuse(
        `A on the tile did not lead to a control labelled exactly "Play" (ring on ${describe(focus)}; ` +
          `saw ${rig.seen.join(", ") || "nothing labelled"})`,
        "the Play button was not found on the app page - A was not pressed",
        target.appid,
        name,
      );
    }
    route = await rig.readRoute();
    rig.stage(
      "open-app-page",
      true,
      `A on the tile; ring on "Play" after ${playWalk} DOWN press(es); route ${route ?? "unreadable"}`,
      1 + playWalk,
    );

    // ---- press-play: 1 A -----------------------------------------------------
    //
    // Authorised by the read that saw "Play". Measured: the app id appears in
    // RunningApps under a second, the route becomes /apprunning, and the game's
    // own window is still loading -- RunningApps is the launch signal, not the
    // game being playable.
    await rig.press("A", "press-play");
    const wait = await rig.waitForRunning((apps) => apps.some((a) => a.appid === target.appid), waitMs);
    rig.runningAfter = wait.apps;
    route = await rig.readRoute();
    const runningNow = wait.apps?.find((a) => a.appid === target.appid) ?? null;
    rig.stage(
      "press-play",
      wait.satisfied,
      wait.satisfied
        ? `appid ${target.appid} appeared in RunningApps after ${wait.waitedMs}ms (${wait.polls} poll(s)); route ${route ?? "unreadable"}`
        : `RunningApps did not list appid ${target.appid} within ${waitMs}ms (${wait.polls} poll(s)` +
          `${wait.reason ? `, last read failed: ${wait.reason}` : ""}); route ${route ?? "unreadable"}`,
      1,
    );
    if (!wait.satisfied || !runningNow) {
      return {
        ok: false,
        appid: target.appid,
        name,
        running: null,
        route,
        reason:
          `A was pressed on "Play" but RunningApps never listed appid ${target.appid} within ${waitMs}ms; ` +
          "the game may still be starting, or a launcher or controller-layout prompt may be up (plan 07 § 7)",
        summary: `pressed Play for "${name}" but could not confirm the launch within ${waitMs}ms`,
      };
    }
    return {
      ok: true,
      appid: target.appid,
      name: runningNow.display_name || name,
      running: { appid: runningNow.appid, name: runningNow.display_name || name },
      route,
      summary: `launched ${nameOf(target)} - ${stagesLine(rig.stages)}; reopen the plugin with deck_openPlugin`,
    };
  });
}

// ---------------------------------------------------------------------------
// deck.exitGame
// ---------------------------------------------------------------------------

export async function exitGame(opts: ExitGameOptions = {}): Promise<GameSessionResult> {
  const waitMs = opts.waitMs ?? 60_000;

  return runSession("exit-game", opts, (n) => EXIT_CHECKLIST(n ?? "the game"), null, async (rig) => {
    const refuse = (reason: string, summary: string, game: RunningApp | null): Outcome => ({
      ok: false,
      appid: game?.appid ?? null,
      name: game?.display_name ?? null,
      running: game ? { appid: game.appid, name: game.display_name } : null,
      route: null,
      reason,
      summary,
    });

    // ---- read-running: 0 presses --------------------------------------------
    const before = await rig.readRunning();
    rig.runningBefore = before.ok ? before.apps : null;
    if (!before.ok) {
      rig.stage("read-running", false, before.reason ?? "RunningApps unreadable", 0);
      return refuse(
        `could not read window.SteamUIStore.RunningApps in ${SHARED_JS_CONTEXT}: ${before.reason}`,
        "could not read Steam's running-app list, so nothing was pressed",
        null,
      );
    }
    if (before.apps.length === 0) {
      rig.stage("read-running", true, "RunningApps is empty", 0);
      rig.runningAfter = before.apps;
      return {
        ok: true,
        appid: null,
        name: null,
        nothingRunning: true,
        running: null,
        route: await rig.readRoute(),
        summary: "nothing is running - nothing was pressed",
      };
    }
    const game = before.apps[0];
    const others = before.apps.slice(1);
    rig.stage(
      "read-running",
      true,
      `${nameOf(game)} is running` + (others.length ? `, and so ${others.length === 1 ? "is" : "are"} ${others.map(nameOf).join(", ")}` : ""),
      0,
    );

    // ---- open-main-menu: 1 GUIDE ---------------------------------------------
    //
    // Measured with a game up (plan 07 § 6): the main menu opens with a NEW top
    // entry named after the game, above Home, and the ring on it; ~800 ms to
    // settle. Before the press the ring is usually unreadable -- the game owns
    // input and no Steam page carries a marker -- which is expected here, not a
    // failure. From inside an already-open menu GUIDE would close it, so that
    // case walks UP to the entry instead.
    let focus = await rig.readFocus();
    rig.record(ownLabelOf(focus));
    const from = focus.ok ? `ring on ${describe(focus)}` : "no ring readable (the game owns input)";
    const onEntry = (r: ReadFocusResult): boolean => inMainMenu(r) && namesGame(ownLabelOf(r), game.display_name);
    if (onEntry(focus)) {
      rig.stage("open-main-menu", true, `main menu already open on ${describe(focus)}, so GUIDE was not pressed`, 0);
    } else if (inMainMenu(focus)) {
      const w = await rig.walk("UP", HOME_BUDGET, "open-main-menu", focus, onEntry);
      focus = w.focus;
      rig.stage(
        "open-main-menu",
        w.found,
        w.found
          ? `main menu already open (${from}); ${w.presses} UP press(es) reached ${describe(focus)}`
          : `main menu already open (${from}); ${w.presses} UP press(es) never reached an entry named "${game.display_name}" (${w.ended})`,
        w.presses,
      );
      if (!w.found) {
        return refuse(
          `the main menu is open but no entry named "${game.display_name}" was found walking UP (${w.ended})`,
          "could not reach the running game's menu entry - nothing else was pressed",
          game,
        );
      }
    } else {
      await rig.press("GUIDE", "open-main-menu");
      await rig.sleep(MENU_SETTLE_MS);
      focus = await rig.readFocus();
      rig.record(ownLabelOf(focus));
      const ok = onEntry(focus);
      rig.stage(
        "open-main-menu",
        ok,
        ok
          ? `one GUIDE press from ${from}; ring on ${describe(focus)}, the running game's entry`
          : `one GUIDE press from ${from}; ring on ${describe(focus)}, not an entry named "${game.display_name}"`,
        1,
      );
      if (!ok) {
        return refuse(
          `GUIDE did not put the ring on a main-menu entry named "${game.display_name}"; it is on ${describe(focus)}`,
          "the main menu did not open on the running game's entry - nothing else was pressed",
          game,
        );
      }
    }

    // ---- find-exit: 1 RIGHT, then <= 10 DOWN ---------------------------------
    //
    // Measured: RIGHT lands on "Resume game", the first of eight text-only rows;
    // DOWN x7 reaches "Exit game" (lower-case g), the last. Only the exact label
    // ends the walk; where RIGHT landed is reported, not gated on.
    focus = await rig.nudge("RIGHT", "find-exit");
    rig.record(ownLabelOf(focus));
    const afterRight = ownLabelOf(focus) || describe(focus);
    let w = { found: ownLabelOf(focus) === EXIT_GAME_LABEL, focus, presses: 0, ended: "found" };
    if (!w.found) {
      w = await rig.walk("DOWN", EXIT_BUDGET, "find-exit", focus, (r) => ownLabelOf(r) === EXIT_GAME_LABEL);
      focus = w.focus;
    }
    rig.stage(
      "find-exit",
      w.found,
      `RIGHT landed on "${afterRight}"${afterRight === RESUME_LABEL ? " (as measured)" : ""}; ` +
        (w.found
          ? `"${EXIT_GAME_LABEL}" after ${w.presses} DOWN press(es)`
          : `${w.presses} DOWN press(es) never reached an exact "${EXIT_GAME_LABEL}" (${w.ended})`),
      1 + w.presses,
    );
    if (!w.found) {
      return refuse(
        `no row labelled exactly "${EXIT_GAME_LABEL}" within ${EXIT_BUDGET} DOWN presses (${w.ended}); ` +
          `saw ${rig.seen.join(", ") || "nothing labelled"}`,
        "the game panel's Exit game row was not found - A was not pressed",
        game,
      );
    }

    // ---- confirm: 1 A, a read, then 1 A --------------------------------------
    //
    // Measured: A on "Exit game" opens a modal (#ModalDialogOverlay_Modal_0)
    // with the ring already on <BUTTON> "Confirm", ~1.6 s, and the game keeps
    // running while it is up. Anything but that exact label on the ring is a
    // refusal -- Cancel and Confirm are one press apart, and the rig never
    // guesses which is which.
    await rig.press("A", "confirm");
    await rig.sleep(PAGE_SETTLE_MS);
    focus = await rig.readFocus();
    rig.record(ownLabelOf(focus));
    const inModal = (focus.gpfocus?.selector ?? "").includes("ModalDialogOverlay");
    if (ownLabelOf(focus) !== CONFIRM_LABEL) {
      rig.stage(
        "confirm",
        false,
        `A on "${EXIT_GAME_LABEL}" left the ring on ${describe(focus)}${inModal ? " in a modal" : ""}, not on "${CONFIRM_LABEL}" - refusing to guess`,
        1,
      );
      return refuse(
        `after A on "${EXIT_GAME_LABEL}" the ring is on ${describe(focus)}, not on a control labelled exactly ` +
          `"${CONFIRM_LABEL}"; the rig never guesses between Cancel and Confirm. The game is still running` +
          (inModal ? " and a dialog is open on the Deck" : ""),
        "the exit dialog did not put the ring on Confirm - the second A was not pressed",
        game,
      );
    }
    await rig.press("A", "confirm");
    const wait = await rig.waitForRunning((apps) => !apps.some((a) => a.appid === game.appid), waitMs);
    rig.runningAfter = wait.apps;
    // Measured post-exit state: the main window on /library/app/<appid> with
    // the ring on "Play". Reported so the caller knows where the Deck was left.
    const route = await rig.readRoute();
    const after = await rig.readFocus();
    rig.stage(
      "confirm",
      wait.satisfied,
      wait.satisfied
        ? `A on "${CONFIRM_LABEL}"${inModal ? " in the modal" : ""}; appid ${game.appid} left RunningApps after ${wait.waitedMs}ms ` +
          `(${wait.polls} poll(s)); route ${route ?? "unreadable"}, ring on ${describe(after)}`
        : `A on "${CONFIRM_LABEL}" but appid ${game.appid} was still in RunningApps after ${waitMs}ms (${wait.polls} poll(s)` +
          `${wait.reason ? `, last read failed: ${wait.reason}` : ""})`,
      2,
    );
    const remaining = wait.apps?.filter((a) => a.appid !== game.appid) ?? [];
    if (!wait.satisfied) {
      return {
        ok: false,
        appid: game.appid,
        name: game.display_name,
        running: { appid: game.appid, name: game.display_name },
        route,
        reason: `A was pressed on "${CONFIRM_LABEL}" but ${nameOf(game)} was still in RunningApps after ${waitMs}ms`,
        summary: `confirmed the exit of "${game.display_name}" but could not confirm it stopped within ${waitMs}ms`,
      };
    }
    return {
      ok: true,
      appid: game.appid,
      name: game.display_name,
      running: remaining.length ? { appid: remaining[0].appid, name: remaining[0].display_name } : null,
      route,
      summary:
        `exited ${nameOf(game)} - ${stagesLine(rig.stages)}; the Deck is on ${route ?? "an unread route"} ` +
        `with the ring on ${describe(after)}` +
        (remaining.length ? `; still running: ${remaining.map(nameOf).join(", ")}` : "") +
        "; reopen the plugin with deck_openPlugin",
    };
  });
}

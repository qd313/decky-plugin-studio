/**
 * deck.checkReady -- diff a DECLARED Deck state against the ACTUAL one, before
 * a run spends its first press.
 *
 * Real cases from device QA (docs/planning/09 lane 2): a Deck that had fallen
 * asleep; a stale build proven only by a hand-run md5sum; a foreign CDP tunnel
 * belonging to another session; a game running when none was expected; a
 * Steam dialog on screen that nobody knew about. Every one of those cost a
 * whole run plus the time to work out it was not the thing under test.
 *
 * This tool presses NOTHING. It only reads, through machinery that already
 * exists elsewhere in this codebase, and reports a diff:
 *
 *   awake              -- an injected reachability probe (deck.pingDeck at the
 *                          call site; see CheckReadyOptions.pingFn).
 *   buildMatches       -- buildHash.ts's sha256 manifest compare, reusing
 *                          deploy/copyManifest.ts's listDeploySources() so the
 *                          set of files hashed is exactly the set a deploy
 *                          would copy.
 *   runningAppId       -- gameSession.ts's readRunningApps() (SteamUIStore.RunningApps).
 *   pluginOpen         -- openPlugin.ts's own "is this plugin's panel open"
 *                          logic (panelRootMounted / looksLikeOpenPanelFor),
 *                          exported from there for reuse rather than
 *                          reimplemented here.
 *   noForeignCdpTunnel -- killswitch.ts's cross-process tunnel registry
 *                          (automationStatus().tunnels), filtered to CDP
 *                          tunnels alive under a DIFFERENT process than this one.
 *   modalOnScreen      -- inferred from one readFocus.ts read: whether the
 *                          gamepad ring's selector chain includes
 *                          "ModalDialogOverlay", the exact class gameSession.ts
 *                          measured for the exit-game confirmation dialog.
 *                          BEST EFFORT, not exhaustive -- see the docstring on
 *                          checkModalOnScreen for what this cannot see.
 *   focusRingOwned     -- the same readFocus.ts read's own `ok` / gpfocus.
 *
 * Every field is optional. An absent field produces no entry in `checks` and
 * is not evaluated at all. A field that could not be evaluated (an
 * unreachable Deck, a reader that errors) comes back with verdict "unknown",
 * which counts against `ok` exactly like a "fail" -- an unknown must never
 * read as a pass.
 */
import { openCdpTunnel } from "./cdpTunnel.js";
import { readFocusAt, DEFAULT_TARGETS_SETTLE_MS, ReadFocusResult } from "./readFocus.js";
import { readRunningApps } from "./gameSession.js";
import { looksLikeOpenPanelFor, panelRootMounted } from "./openPlugin.js";
import { automationStatus } from "./killswitch.js";
import { verifyDeployedBuild } from "./buildHash.js";

export type Verdict = "pass" | "fail" | "unknown";

export interface FieldCheck {
  declared: unknown;
  actual: unknown;
  verdict: Verdict;
  reason: string;
}

function pass(declared: unknown, actual: unknown, reason: string): FieldCheck {
  return { declared, actual, verdict: "pass", reason };
}
function fail(declared: unknown, actual: unknown, reason: string): FieldCheck {
  return { declared, actual, verdict: "fail", reason };
}
function unknown(declared: unknown, reason: string): FieldCheck {
  return { declared, actual: null, verdict: "unknown", reason };
}

export interface DeclaredState {
  /** The Deck must (true) or must not (false) be reachable right now. */
  awake?: boolean;
  /** The build installed on the Deck must (true) or must not (false) hash-match the local one. */
  buildMatches?: boolean;
  /** The Steam app id that must be the one running game, or `null` to declare nothing should be running. */
  runningAppId?: number | null;
  /** Name of the plugin whose own panel must currently be open and on screen. */
  pluginOpen?: string;
  /** true to require no live CDP tunnel registered by a process other than this one. */
  noForeignCdpTunnel?: boolean;
  /** Whether a Steam modal dialog should currently be on screen (best-effort -- see module docstring). */
  modalOnScreen?: boolean;
  /** Whether Steam's gamepad focus ring should currently be owned by something. */
  focusRingOwned?: boolean;
}

export interface CheckReadyOptions {
  /** Existing CDP endpoint; omit to open a temporary tunnel for whichever checks need one. */
  cdpUrl?: string;
  targetsSettleMs?: number;
  timeoutMs?: number;
  /** CSS selector for the plugin's own panel root -- see openPlugin.ts's OpenPluginOptions.rootSelector. */
  rootSelector?: string;
  /** Plugin workspace root, for buildMatches. */
  pluginRoot?: string;
  /** Deployed directory name (plugin.json's name, case intact), for buildMatches. */
  pluginName?: string;
  /** SSH user/host for buildMatches. */
  user?: string;
  host?: string;
  /**
   * How to ask whether the Deck is reachable. Deliberately not defaulted here:
   * this module stays free of any dependency on the tools/ layer (which is
   * where deck.pingDeck lives), the same way gameSession.ts and openPlugin.ts
   * take pressFn as a seam rather than importing pressButton's caller. The MCP
   * dispatch (index.ts) is what wires in the real one.
   */
  pingFn?: () => Promise<boolean>;
}

export interface CheckReadyResult {
  ok: boolean;
  checks: Record<string, FieldCheck>;
  failed: string[];
  unknown: string[];
  summary: string;
}

/**
 * The one string readFocusAt uses for "I scanned every target and nothing
 * owns the ring" -- as opposed to "I could not scan at all". Matched as a
 * substring the same way openPlugin.ts and gameSession.ts already do; not a
 * shared constant because none of those files export one.
 */
const RING_UNOWNED = "gpfocus marker not found";

/** Was this focus read able to answer the question at all (owned or genuinely unowned), vs. a hard failure? */
function focusReadable(focus: ReadFocusResult): boolean {
  return focus.ok || (focus.reason ?? "").includes(RING_UNOWNED);
}

// ---------------------------------------------------------------------------
// Individual checks
// ---------------------------------------------------------------------------

async function checkAwake(declared: boolean, pingFn?: () => Promise<boolean>): Promise<FieldCheck> {
  if (!pingFn) return unknown(declared, "no reachability probe was configured to check whether the Deck is awake");
  let actual: boolean;
  try {
    actual = await pingFn();
  } catch (err) {
    return unknown(declared, `could not determine whether the Deck is awake: ${(err as Error).message}`);
  }
  const describe = (b: boolean) => (b ? "reachable" : "unreachable (asleep, or off the network)");
  return declared === actual
    ? pass(declared, actual, `the Deck is ${describe(actual)}, as declared`)
    : fail(declared, actual, `declared the Deck would be ${describe(declared)}, but it is ${describe(actual)}`);
}

function checkBuildMatches(declared: boolean, opts: CheckReadyOptions): FieldCheck {
  const { pluginRoot, pluginName, user, host } = opts;
  const missing = [
    !pluginRoot && "pluginRoot",
    !pluginName && "pluginName",
    !user && "user",
    !host && "host (DECK_IP)",
  ].filter(Boolean);
  if (missing.length > 0) {
    return unknown(declared, `cannot verify the deployed build: missing ${missing.join(", ")}`);
  }
  const result = verifyDeployedBuild(pluginRoot!, pluginName!, user!, host!);
  if (result.matches === null) {
    return unknown(declared, result.reason ?? "could not verify the deployed build");
  }
  const describe = (b: boolean) => (b ? "matches the local build" : "does not match the local build");
  return result.matches === declared
    ? pass(
        declared,
        result.matches,
        result.reason ?? `the deployed build ${describe(result.matches)} (${result.localCount} file(s))`,
      )
    : fail(declared, result.matches, result.reason ?? `the deployed build ${describe(result.matches)}`);
}

function checkNoForeignTunnel(declared: boolean): FieldCheck {
  const status = automationStatus();
  const foreign = status.tunnels.filter((t) => t.kind === "cdp" && t.alive && t.ownerPid !== process.pid);
  const actual = foreign.length === 0;
  if (actual === declared) {
    return pass(
      declared,
      actual,
      actual
        ? "no live CDP tunnel is registered from another process"
        : `${foreign.length} foreign CDP tunnel(s) are alive, as declared`,
    );
  }
  return fail(
    declared,
    actual,
    declared
      ? `${foreign.length} foreign CDP tunnel(s) are alive (owner pid(s) ${foreign.map((t) => t.ownerPid).join(", ")}) -- another session may be driving this Deck`
      : "declared a foreign CDP tunnel would be present, but none is registered",
  );
}

async function checkRunningAppId(declared: number | null, cdpBase: string): Promise<FieldCheck> {
  const r = await readRunningApps(cdpBase);
  if (!r.ok) return unknown(declared, r.reason ?? "could not read Steam's running-app list");
  const list = () => (r.apps.length ? r.apps.map((a) => `${a.display_name} (${a.appid})`).join(", ") : "empty");
  if (declared === null) {
    return r.apps.length === 0
      ? pass(declared, [], "RunningApps is empty, as declared")
      : fail(declared, r.apps.map((a) => a.appid), `RunningApps is not empty: ${list()}`);
  }
  const hit = r.apps.find((a) => a.appid === declared);
  return hit
    ? pass(declared, r.apps.map((a) => a.appid), `appid ${declared} (${hit.display_name}) is running, as declared`)
    : fail(declared, r.apps.map((a) => a.appid), `appid ${declared} is not running; RunningApps: ${list()}`);
}

async function checkPluginOpen(
  declared: string,
  focus: ReadFocusResult,
  cdpBase: string,
  rootSelector?: string,
): Promise<FieldCheck> {
  let rootMounted: boolean | null = null;
  if (rootSelector) rootMounted = await panelRootMounted(rootSelector, cdpBase);

  if (rootMounted === null && !focusReadable(focus)) {
    return unknown(declared, focus.reason ?? `could not confirm whether "${declared}" is open`);
  }
  const open = rootMounted !== null ? rootMounted : looksLikeOpenPanelFor(focus, declared);
  return open
    ? pass(
        declared,
        true,
        `"${declared}" is open` + (rootMounted === true ? `, confirmed by "${rootSelector}"` : ""),
      )
    : fail(
        declared,
        false,
        `"${declared}" does not appear to be open` +
          (rootMounted === false ? ` ("${rootSelector}" is not in the document)` : ""),
      );
}

function selectorsOf(focus: ReadFocusResult): string[] {
  const out: string[] = [];
  if (focus.gpfocus?.selector) out.push(focus.gpfocus.selector);
  for (const w of focus.gpfocusWithin) if (w.selector) out.push(w.selector);
  return out;
}

function checkFocusRingOwned(declared: boolean, focus: ReadFocusResult): FieldCheck {
  if (!focus.ok) {
    if ((focus.reason ?? "").includes(RING_UNOWNED)) {
      return declared === false
        ? pass(declared, false, "the gamepad focus ring is unowned, as declared")
        : fail(declared, false, `the gamepad focus ring is unowned (${focus.reason})`);
    }
    return unknown(declared, focus.reason ?? "could not read Steam's focus state");
  }
  return declared === true
    ? pass(declared, true, `the gamepad focus ring is owned (${focus.gpfocus?.tag ?? "?"})`)
    : fail(declared, true, "declared the focus ring would be unowned, but something owns it");
}

/**
 * BEST EFFORT, not exhaustive. This asks only whether the CONTROL THE GAMEPAD
 * RING IS ON is inside a `ModalDialogOverlay` -- the one class this codebase
 * has actually measured a Steam modal use (gameSession.ts's exit-game confirm
 * dialog). A modal that does not capture the gamepad ring, or that Steam
 * renders under a different class in some other build, is invisible to this
 * check and would read as "no modal" -- which is why, when the ring is merely
 * UNOWNED (a common, benign state after closing a plugin panel -- see
 * readFocus.ts), this reports `false` rather than `unknown`: there is no
 * positive evidence of a modal, but there is also no proof of its absence. A
 * general modal probe that scans every CEF target by content, the way
 * probeQuickAccess() asks the Quick Access page directly, would close this
 * gap; it does not exist yet and building it was out of scope for this
 * composition-only pass.
 */
function checkModalOnScreen(declared: boolean, focus: ReadFocusResult): FieldCheck {
  if (!focusReadable(focus)) {
    return unknown(declared, focus.reason ?? "could not read Steam's UI to look for a modal");
  }
  const actual = focus.ok && selectorsOf(focus).some((s) => s.includes("ModalDialogOverlay"));
  if (actual === declared) {
    return pass(
      declared,
      actual,
      actual
        ? "the gamepad ring is inside a ModalDialogOverlay, as declared"
        : "no modal was detected where the gamepad ring is, as declared",
    );
  }
  return fail(
    declared,
    actual,
    declared
      ? "declared a modal would be on screen, but the ring is not inside one"
      : "the gamepad ring is inside a ModalDialogOverlay -- a modal is on screen",
  );
}

// ---------------------------------------------------------------------------
// The aggregator
// ---------------------------------------------------------------------------

const CDP_FIELDS = ["runningAppId", "pluginOpen", "modalOnScreen", "focusRingOwned"] as const;

function declaredCdpField(declared: DeclaredState, field: (typeof CDP_FIELDS)[number]): boolean {
  return declared[field] !== undefined;
}

export async function checkDeckReady(
  declared: DeclaredState,
  opts: CheckReadyOptions = {},
): Promise<CheckReadyResult> {
  const checks: Record<string, FieldCheck> = {};

  // Cheapest and most consequential first: is somebody else already driving
  // this Deck? No CDP call needed -- the registry is a local file.
  if (declared.noForeignCdpTunnel !== undefined) {
    checks.noForeignCdpTunnel = checkNoForeignTunnel(declared.noForeignCdpTunnel);
  }

  if (declared.awake !== undefined) {
    checks.awake = await checkAwake(declared.awake, opts.pingFn);
  }

  if (declared.buildMatches !== undefined) {
    checks.buildMatches = checkBuildMatches(declared.buildMatches, opts);
  }

  const needsCdp = CDP_FIELDS.some((f) => declaredCdpField(declared, f));
  if (needsCdp) {
    let cdpBase = opts.cdpUrl;
    let closeTunnel: (() => void) | null = null;
    if (!cdpBase) {
      try {
        const tunnel = await openCdpTunnel();
        cdpBase = tunnel.base;
        closeTunnel = tunnel.close;
      } catch (err) {
        const reason = `could not reach the Deck's CEF debugger: ${(err as Error).message}`;
        for (const f of CDP_FIELDS) {
          if (declaredCdpField(declared, f)) checks[f] = unknown(declared[f], reason);
        }
      }
    }
    if (cdpBase) {
      try {
        const timeoutMs = opts.timeoutMs ?? 10_000;
        const needsFocus =
          declared.focusRingOwned !== undefined ||
          declared.modalOnScreen !== undefined ||
          declared.pluginOpen !== undefined;
        const focus: ReadFocusResult | null = needsFocus
          ? await readFocusAt(cdpBase, timeoutMs, undefined, {
              targetsSettleMs: opts.targetsSettleMs ?? DEFAULT_TARGETS_SETTLE_MS,
            })
          : null;

        if (declared.focusRingOwned !== undefined) {
          checks.focusRingOwned = checkFocusRingOwned(declared.focusRingOwned, focus!);
        }
        if (declared.modalOnScreen !== undefined) {
          checks.modalOnScreen = checkModalOnScreen(declared.modalOnScreen, focus!);
        }
        if (declared.pluginOpen !== undefined) {
          checks.pluginOpen = await checkPluginOpen(declared.pluginOpen, focus!, cdpBase, opts.rootSelector);
        }
        if (declared.runningAppId !== undefined) {
          checks.runningAppId = await checkRunningAppId(declared.runningAppId, cdpBase);
        }
      } finally {
        closeTunnel?.();
      }
    }
  }

  const failed = Object.entries(checks)
    .filter(([, c]) => c.verdict === "fail")
    .map(([k]) => k);
  const unknownKeys = Object.entries(checks)
    .filter(([, c]) => c.verdict === "unknown")
    .map(([k]) => k);
  const ok = failed.length === 0 && unknownKeys.length === 0;

  const summary =
    Object.keys(checks).length === 0
      ? "nothing was declared, so nothing was checked"
      : ok
        ? `ready: ${Object.keys(checks).length} declared check(s) passed (${Object.keys(checks).join(", ")})`
        : `not ready: ${[...failed.map((k) => `${k} (${checks[k].reason})`), ...unknownKeys.map((k) => `${k} unknown (${checks[k].reason})`)].join("; ")}`;

  return { ok, checks, failed, unknown: unknownKeys, summary };
}

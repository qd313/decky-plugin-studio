/**
 * Tests for deck.checkReady -- the declared-vs-actual diff.
 *
 * The CDP layer is faked with the real fake CDP server (startFakeCdp), the
 * same idiom readPage.test.ts / walkTo.test.ts / runSequence.test.ts /
 * deckDeploy.test.ts use, so every CDP-dependent check runs through the real
 * `readFocusAt` / `readRunningApps` / `panelRootMounted` / `readPage` code --
 * only the WebSocket server on the other end is a double. The SSH layer for
 * buildMatches is faked the same way deckDeploy.test.ts fakes it: swapping
 * `proc.execSync` (deploy/deployHelpers.ts's exec seam), never a real ssh.
 *
 * THE CONFIG DIR IS REDIRECTED to a temp home, as in killswitch.test.ts and
 * gameSession.test.ts: automationStatus() (used by noForeignCdpTunnel) and
 * readDeckEnv() (used when no cdpUrl is given) both derive from
 * os.homedir() at call time, so pointing USERPROFILE/HOME at a temp dir moves
 * both with them -- a developer's real killswitch/tunnel registry and deck.env
 * are never touched by this suite.
 */
import { test, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { localBuildManifest } from "./buildHash.js";
import { proc } from "../deploy/deployHelpers.js";
import { startFakeCdp } from "./__testutil__/fakeCdp.js";

const realHome = { USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME };
const realDeckIp = process.env.DECK_IP;
const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "dps-checkready-"));
process.env.USERPROFILE = tempHome;
process.env.HOME = tempHome;
delete process.env.DECK_IP;

const { checkDeckReady } = await import("./checkReady.js");
const { getConfigDir } = await import("../config.js");

function assertSandboxed(): void {
  assert.ok(
    getConfigDir().startsWith(tempHome),
    `config dir escaped the sandbox: ${getConfigDir()} is not under ${tempHome}`,
  );
}

function tunnelDir(): string {
  return path.join(getConfigDir(), "automation-tunnels");
}

function clearTunnels(): void {
  fs.rmSync(tunnelDir(), { recursive: true, force: true });
}

/** A live CDP tunnel registered by a DIFFERENT process -- what another session's run looks like. */
function registerForeignTunnel(): void {
  fs.mkdirSync(tunnelDir(), { recursive: true });
  fs.writeFileSync(
    path.join(tunnelDir(), "foreign.json"),
    JSON.stringify({
      id: "foreign",
      kind: "cdp",
      pid: process.pid, // alive, so the registry does not prune it as stale
      ownerPid: process.pid + 12345, // deliberately not this process
      since: new Date().toISOString(),
      detail: "another agent's tunnel",
    }),
    "utf8",
  );
}

before(() => assertSandboxed());
beforeEach(() => {
  assertSandboxed();
  clearTunnels();
});
after(() => {
  process.env.USERPROFILE = realHome.USERPROFILE;
  process.env.HOME = realHome.HOME;
  if (realDeckIp === undefined) delete process.env.DECK_IP;
  else process.env.DECK_IP = realDeckIp;
  fs.rmSync(tempHome, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function sha256(buf: Buffer | string): string {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function makeFixturePlugin(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dps-checkready-plugin-"));
  fs.writeFileSync(path.join(root, "plugin.json"), JSON.stringify({ name: "bonsAI", version: "1.0.0" }));
  fs.mkdirSync(path.join(root, "dist"));
  fs.writeFileSync(path.join(root, "dist", "index.js"), "// built js\n");
  fs.writeFileSync(path.join(root, "main.py"), "# entry\n");
  return root;
}

function sha256sumOutput(entries: { path: string; sha256: string }[]): string {
  return entries.map((e) => `${e.sha256}  ${e.path}`).join("\n") + "\n";
}

async function withFakeExec<T>(impl: (cmd: string) => string, fn: () => Promise<T> | T): Promise<T> {
  const original = proc.execSync;
  proc.execSync = ((cmd: string) => impl(cmd)) as unknown as typeof proc.execSync;
  try {
    return await fn();
  } finally {
    proc.execSync = original;
  }
}

/** The ring on bonsAI's own list row in the Decky pane -- panel NOT open, just listed. */
const FOCUSED_BONSAI_LIST_ROW = {
  hasGpfocus: true,
  elementCount: 300,
  gpfocus: {
    selector: "#quickaccess_content_999 > button.DialogButton",
    selectorVerified: true,
    tag: "BUTTON",
    id: null,
    classes: ["DialogButton", "Focusable", "gpfocus"],
    ariaLabel: null,
    text: "bonsAI",
    ownerText: "bonsAI",
    rect: { x: 64, y: 74, w: 268, h: 46 },
  },
  gpfocusWithin: [],
  activeElement: null,
  agree: false,
  quickAccessTab: "999",
  visibleQuickAccessTab: "999",
  deckyPluginRoot: true,
  deckyPanelLabels: ["bonsAI"],
};

/** The ring on the exit-game confirm dialog's Confirm button -- the one modal this codebase has measured. */
const FOCUSED_MODAL_CONFIRM = {
  hasGpfocus: true,
  elementCount: 20,
  gpfocus: {
    selector: "#ModalDialogOverlay_Modal_0 > div > button.DialogButton",
    selectorVerified: true,
    tag: "BUTTON",
    id: null,
    classes: ["DialogButton", "Focusable", "gpfocus"],
    ariaLabel: null,
    text: "Confirm",
    ownerText: "Confirm",
    rect: { x: 100, y: 100, w: 120, h: 40 },
  },
  gpfocusWithin: [],
  activeElement: null,
  agree: false,
  quickAccessTab: null,
  visibleQuickAccessTab: null,
  deckyPluginRoot: false,
  deckyPanelLabels: [],
};

const UNOWNED = { hasGpfocus: false };

// ---------------------------------------------------------------------------
// A matching declared state passes
// ---------------------------------------------------------------------------

test("a matching declared state passes every declared check, and nothing else appears", async () => {
  const root = makeFixturePlugin();
  const localManifest = localBuildManifest(root);

  const fake = await startFakeCdp(["SharedJSContext", "QuickAccess_uid2"], (title, i) => {
    // SharedJSContext is asked twice: once by the focus scan (which must find
    // nothing there, same as a real Deck), and once by readRunningApps -- the
    // read index is what tells the two apart, the same scripting idiom
    // killswitch.test.ts uses for a mid-run event.
    if (title === "SharedJSContext") return i === 0 ? UNOWNED : [];
    return FOCUSED_BONSAI_LIST_ROW;
  });

  try {
    const result = await withFakeExec(
      () => sha256sumOutput(localManifest),
      () =>
        checkDeckReady(
          {
            awake: true,
            buildMatches: true,
            runningAppId: null,
            pluginOpen: "bonsAI",
            noForeignCdpTunnel: true,
            modalOnScreen: false,
            focusRingOwned: true,
          },
          {
            cdpUrl: fake.base,
            pluginRoot: root,
            pluginName: "bonsAI",
            user: "deck",
            host: "203.0.113.5",
            pingFn: async () => true,
          },
        ),
    );

    assert.equal(result.ok, true, result.summary);
    assert.deepEqual(result.failed, []);
    assert.deepEqual(result.unknown, []);
    assert.equal(Object.keys(result.checks).length, 7, JSON.stringify(Object.keys(result.checks)));
    for (const [name, check] of Object.entries(result.checks)) {
      assert.equal(check.verdict, "pass", `${name} did not pass: ${check.reason}`);
    }
  } finally {
    await fake.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// An absent field is not checked at all
// ---------------------------------------------------------------------------

test("an empty declared state checks nothing and passes vacuously", async () => {
  const result = await checkDeckReady({});
  assert.equal(result.ok, true);
  assert.deepEqual(result.checks, {});
  assert.match(result.summary, /nothing was declared/);
});

test("only the declared fields are evaluated -- everything else is simply absent", async () => {
  const result = await checkDeckReady({ noForeignCdpTunnel: true });
  assert.deepEqual(Object.keys(result.checks), ["noForeignCdpTunnel"]);
  assert.equal(result.ok, true);
});

// ---------------------------------------------------------------------------
// Each individual mismatch fails with its own named reason
// ---------------------------------------------------------------------------

test("awake: declaring the Deck reachable when it is not fails, named", async () => {
  const result = await checkDeckReady({ awake: true }, { pingFn: async () => false });
  assert.equal(result.ok, false);
  assert.deepEqual(result.failed, ["awake"]);
  assert.match(result.checks.awake.reason, /unreachable/);
});

test("buildMatches: a build with nothing deployed fails, naming the redeploy", async () => {
  const root = makeFixturePlugin();
  try {
    const result = await withFakeExec(
      () => "", // ssh succeeded but found nothing under the target -- an empty remote manifest
      () =>
        checkDeckReady(
          { buildMatches: true },
          { pluginRoot: root, pluginName: "bonsAI", user: "deck", host: "203.0.113.5" },
        ),
    );
    assert.equal(result.ok, false);
    assert.deepEqual(result.failed, ["buildMatches"]);
    assert.match(result.checks.buildMatches.reason, /redeploy/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("runningAppId: a different game running fails, naming what actually is", async () => {
  const fake = await startFakeCdp(["SharedJSContext"], () => [{ appid: 999, display_name: "Other Game" }]);
  try {
    const result = await checkDeckReady({ runningAppId: 220 }, { cdpUrl: fake.base });
    assert.equal(result.ok, false);
    assert.deepEqual(result.failed, ["runningAppId"]);
    assert.match(result.checks.runningAppId.reason, /Other Game/);
  } finally {
    await fake.close();
  }
});

test('runningAppId: declaring "nothing running" fails when something is', async () => {
  const fake = await startFakeCdp(["SharedJSContext"], () => [{ appid: 220, display_name: "Half-Life 2" }]);
  try {
    const result = await checkDeckReady({ runningAppId: null }, { cdpUrl: fake.base });
    assert.equal(result.ok, false);
    assert.deepEqual(result.failed, ["runningAppId"]);
    assert.match(result.checks.runningAppId.reason, /Half-Life 2/);
  } finally {
    await fake.close();
  }
});

test("pluginOpen: a plugin whose panel is not open fails", async () => {
  const fake = await startFakeCdp(["QuickAccess_uid2"], () => ({
    hasGpfocus: true,
    elementCount: 10,
    gpfocus: {
      selector: "#quickaccess_content_0 > div",
      selectorVerified: true,
      tag: "DIV",
      id: null,
      classes: [],
      ariaLabel: null,
      text: "Notifications",
      ownerText: "",
      rect: null,
    },
    gpfocusWithin: [],
    activeElement: null,
    agree: false,
    quickAccessTab: "0",
    visibleQuickAccessTab: "0",
    deckyPluginRoot: false,
    deckyPanelLabels: [],
  }));
  try {
    const result = await checkDeckReady({ pluginOpen: "bonsAI" }, { cdpUrl: fake.base });
    assert.equal(result.ok, false);
    assert.deepEqual(result.failed, ["pluginOpen"]);
    assert.match(result.checks.pluginOpen.reason, /does not appear to be open/);
  } finally {
    await fake.close();
  }
});

test("pluginOpen: a rootSelector overrides the label heuristic -- P1-9's exact trap, resolved correctly", async () => {
  // The ring is on bonsAI's LIST ROW (both "Decky" and "bonsAI" are pane
  // labels here, the shape that used to false-positive -- see
  // openPlugin.ts's looksLikeOpenPanelFor docstring). The selector is the
  // authority and says the panel really is mounted.
  let call = 0;
  const fake = await startFakeCdp(["QuickAccess_uid2"], () => {
    call++;
    if (call === 1) {
      return {
        hasGpfocus: true,
        elementCount: 5,
        gpfocus: {
          selector: "#quickaccess_content_999 > div.PanelHeader",
          selectorVerified: true,
          tag: "DIV",
          id: null,
          classes: [],
          ariaLabel: null,
          text: "Decky",
          ownerText: "",
          rect: null,
        },
        gpfocusWithin: [],
        activeElement: null,
        agree: false,
        quickAccessTab: "999",
        visibleQuickAccessTab: "999",
        deckyPluginRoot: true,
        deckyPanelLabels: ["Decky", "bonsAI"],
      };
    }
    return true; // panelRootMounted's own probe: the selector IS in the document
  });
  try {
    const result = await checkDeckReady({ pluginOpen: "bonsAI" }, { cdpUrl: fake.base, rootSelector: ".bonsai-scope" });
    assert.equal(result.checks.pluginOpen.verdict, "pass", result.checks.pluginOpen.reason);
    assert.match(result.checks.pluginOpen.reason, /confirmed by/);
  } finally {
    await fake.close();
  }
});

test("noForeignCdpTunnel: a live tunnel from another process fails, naming its owner", async () => {
  registerForeignTunnel();
  const result = await checkDeckReady({ noForeignCdpTunnel: true });
  assert.equal(result.ok, false);
  assert.deepEqual(result.failed, ["noForeignCdpTunnel"]);
  assert.match(result.checks.noForeignCdpTunnel.reason, /foreign CDP tunnel/);
});

test("modalOnScreen: an open confirm dialog fails when none was declared", async () => {
  const fake = await startFakeCdp(["QuickAccess_uid2"], () => FOCUSED_MODAL_CONFIRM);
  try {
    const result = await checkDeckReady({ modalOnScreen: false }, { cdpUrl: fake.base });
    assert.equal(result.ok, false);
    assert.deepEqual(result.failed, ["modalOnScreen"]);
    assert.match(result.checks.modalOnScreen.reason, /modal is on screen/);
  } finally {
    await fake.close();
  }
});

test("focusRingOwned: an unowned ring fails when ownership was declared", async () => {
  const fake = await startFakeCdp(["QuickAccess_uid2"], () => UNOWNED);
  try {
    const result = await checkDeckReady({ focusRingOwned: true }, { cdpUrl: fake.base });
    assert.equal(result.ok, false);
    assert.deepEqual(result.failed, ["focusRingOwned"]);
    assert.match(result.checks.focusRingOwned.reason, /unowned/);
  } finally {
    await fake.close();
  }
});

test("an unowned ring is a definitive pass for focusRingOwned:false and modalOnScreen:false, not unknown", async () => {
  // A common, benign state (readFocus.ts: focus is unowned right after a
  // plugin opens or an Ask finishes) must not read as "cannot tell" every time.
  const fake = await startFakeCdp(["QuickAccess_uid2"], () => UNOWNED);
  try {
    const result = await checkDeckReady({ focusRingOwned: false, modalOnScreen: false }, { cdpUrl: fake.base });
    assert.equal(result.ok, true, result.summary);
    assert.equal(result.checks.focusRingOwned.verdict, "pass");
    assert.equal(result.checks.modalOnScreen.verdict, "pass");
  } finally {
    await fake.close();
  }
});

// ---------------------------------------------------------------------------
// A check that cannot be evaluated reports that, never a silent pass
// ---------------------------------------------------------------------------

test("awake: no reachability probe configured is unknown, not a silent pass", async () => {
  const result = await checkDeckReady({ awake: true });
  assert.equal(result.ok, false);
  assert.deepEqual(result.unknown, ["awake"]);
});

test("buildMatches: missing pluginRoot/pluginName/host is unknown, naming what is missing", async () => {
  const result = await checkDeckReady({ buildMatches: true });
  assert.equal(result.ok, false);
  assert.deepEqual(result.unknown, ["buildMatches"]);
  assert.match(result.checks.buildMatches.reason, /missing/);
});

test("a Deck that cannot be reached over CDP at all reports every CDP-dependent check as unknown", async () => {
  // No cdpUrl given, and DECK_IP is unset in this sandbox -- openCdpTunnel()
  // refuses synchronously (DeckNotConfiguredError) rather than a network call.
  const result = await checkDeckReady({
    focusRingOwned: true,
    modalOnScreen: false,
    runningAppId: null,
    pluginOpen: "bonsAI",
  });
  assert.equal(result.ok, false);
  assert.deepEqual(
    [...result.unknown].sort(),
    ["focusRingOwned", "modalOnScreen", "pluginOpen", "runningAppId"].sort(),
  );
  for (const name of result.unknown) {
    assert.match(result.checks[name].reason, /could not reach the Deck/);
  }
});

test("a reader that errors mid-scan (a broken CDP endpoint) is unknown, never a false pass or false fail", async () => {
  const result = await checkDeckReady(
    { focusRingOwned: true, runningAppId: null },
    { cdpUrl: "http://127.0.0.1:1", timeoutMs: 800 },
  );
  assert.equal(result.ok, false);
  assert.deepEqual([...result.unknown].sort(), ["focusRingOwned", "runningAppId"]);
  assert.equal(result.failed.length, 0, "an unreachable endpoint must never be reported as a confirmed mismatch");
});

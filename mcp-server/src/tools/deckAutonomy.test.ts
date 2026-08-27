/**
 * Tests for the two "a probe needs a deadline / a status needs a probe" bugs
 * in deckAutonomy.ts:
 *
 *   Bug A: getEnv() hung forever on an unreachable DECK_IP because
 *   probeRemoteDeck()'s ssh calls had no timeout at all -- a wrong IP could
 *   block on the OS-level TCP connect timeout for 40s+ with no way out.
 *
 *   Bug B: deck_status reported tunnel/ingest/Deck/Ollama health but nothing
 *   about whether the ESP32 controller bridge could actually open its COM
 *   port -- the thing that actually blocks a session.
 *
 * Both are tested by faking the boundary (the ssh exec / the pad.py runner)
 * so no real serial port, ssh, or network is ever touched here.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { probeRemoteDeck, probeBridge, getConfiguredBridgePort } from "./deckAutonomy.js";

/**
 * probeBridge() checks the same DPS_NO_BRIDGE guard pressButton.ts uses, so
 * that a real spawn is impossible under the suite even if a test forgot to
 * inject a fake runner. That guard is exercised directly below (see "the
 * DPS_NO_BRIDGE guard..."), so the rest of the probeBridge tests need it
 * explicitly cleared -- every one of them still only ever reaches an
 * injected fake `findPad`/`run`, never a real spawn.
 */
function withBridgeGuard<T>(value: string | undefined, fn: () => T): T {
  const prior = process.env.DPS_NO_BRIDGE;
  if (value === undefined) delete process.env.DPS_NO_BRIDGE;
  else process.env.DPS_NO_BRIDGE = value;
  try {
    return fn();
  } finally {
    if (prior === undefined) delete process.env.DPS_NO_BRIDGE;
    else process.env.DPS_NO_BRIDGE = prior;
  }
}

// ---- Bug A: probeRemoteDeck must never hang, and must report a timeout ----

test("probeRemoteDeck returns unreachable+reason when the first ssh call times out, instead of hanging or throwing", async () => {
  let calls = 0;
  const fakeExec = (_cmd: string, _timeoutMs: number) => {
    calls += 1;
    return { text: "", timedOut: true };
  };

  const start = Date.now();
  const result = await probeRemoteDeck("deck", "10.0.0.99", { timeoutMs: 50, exec: fakeExec });
  const elapsed = Date.now() - start;

  // The whole point of the fix: this resolves promptly (no 40s+ OS-level TCP
  // hang) and reports the timeout as a finding rather than throwing or
  // returning a half-populated "everything is fine" shape.
  assert.ok(elapsed < 1000, `probeRemoteDeck took ${elapsed}ms -- it should return almost immediately`);
  assert.deepEqual(result, {
    unreachable: true,
    reason: "ssh probe timed out after 50ms",
  });
  // Once the first call reports a timeout, the probe should stop rather than
  // pressing on with two more doomed ssh calls.
  assert.equal(calls, 1);
});

test("probeRemoteDeck reports unreachable when a later call times out, not just the first", async () => {
  let calls = 0;
  const fakeExec = (_cmd: string, _timeoutMs: number) => {
    calls += 1;
    if (calls < 3) return { text: "ok", timedOut: false };
    return { text: "", timedOut: true };
  };

  const result = await probeRemoteDeck("deck", "10.0.0.99", { timeoutMs: 5000, exec: fakeExec });
  assert.equal(calls, 3);
  assert.equal((result as { unreachable?: boolean }).unreachable, true);
  assert.match((result as { reason?: string }).reason ?? "", /timed out/);
});

test("probeRemoteDeck returns the normal shape when every ssh call answers in time", async () => {
  const responses = ["PRETTY_NAME=SteamOS", "yes", "active"];
  let i = 0;
  const fakeExec = (_cmd: string, _timeoutMs: number) => ({ text: responses[i++], timedOut: false });

  const result = await probeRemoteDeck("deck", "192.168.1.50", { timeoutMs: 4000, exec: fakeExec });
  assert.equal(result.unreachable, undefined);
  assert.equal(result.osRelease, "PRETTY_NAME=SteamOS");
  assert.equal(result.homebrewPresent, "yes");
  assert.equal(result.pluginLoaderActive, "active");
});

// ---- Bug B: deck_status needs to know whether the bridge is reachable ----

test("probeBridge reports bridgeReady:false with a reason when pad.py cannot be found", () =>
  withBridgeGuard(undefined, async () => {
    const result = await probeBridge({
      findPad: () => null,
      run: () => {
        throw new Error("run() must not be called when pad.py is absent");
      },
    });

    assert.equal(result.bridgeReady, false);
    assert.equal(result.port, getConfiguredBridgePort());
    assert.match(result.reason ?? "", /pad\.py not found/);
  }));

test("probeBridge reports bridgeReady:false with a reason when the port cannot be opened (board unplugged)", () =>
  withBridgeGuard(undefined, async () => {
    const result = await probeBridge({
      findPad: () => "C:/fake/bridge/tools/pad.py",
      run: (_pad, _port, _timeoutMs) => ({
        ok: false,
        reason: "pad.py status exit 1: could not open port 'COM7': FileNotFoundError",
      }),
    });

    assert.equal(result.bridgeReady, false);
    assert.match(result.reason ?? "", /could not open port/);
  }));

test("probeBridge reports bridgeReady:true and the configured port when the status probe succeeds", () =>
  withBridgeGuard(undefined, async () => {
    let seenPort: string | undefined;
    const result = await probeBridge({
      findPad: () => "C:/fake/bridge/tools/pad.py",
      run: (_pad, port, _timeoutMs) => {
        seenPort = port;
        return { ok: true };
      },
    });

    assert.equal(result.bridgeReady, true);
    assert.equal(result.reason, undefined);
    assert.equal(seenPort, getConfiguredBridgePort());
    assert.equal(result.port, getConfiguredBridgePort());
  }));

test("probeBridge never calls a real runner or spawns anything -- only the injected run() fires", () =>
  withBridgeGuard(undefined, async () => {
    let runCalls = 0;
    await probeBridge({
      findPad: () => "C:/fake/bridge/tools/pad.py",
      run: () => {
        runCalls += 1;
        return { ok: true };
      },
    });
    assert.equal(runCalls, 1);
  }));

test("the DPS_NO_BRIDGE guard stops probeBridge before it ever calls findPad or run", () =>
  withBridgeGuard("1", async () => {
    const result = await probeBridge({
      findPad: () => {
        throw new Error("findPad must not be called while DPS_NO_BRIDGE is set");
      },
      run: () => {
        throw new Error("run must not be called while DPS_NO_BRIDGE is set");
      },
    });

    assert.equal(result.bridgeReady, false);
    assert.match(result.reason ?? "", /DPS_NO_BRIDGE/);
  }));

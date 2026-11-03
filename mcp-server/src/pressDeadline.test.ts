/**
 * Plan 12 lane B: a press after its call's deadline refuses.
 *
 * Lane D abandoned a timed-out call's promise instead of stopping it, and
 * said so: "a late walkTo could still press beside the next call". These
 * tests pin the fence that closes that. Every press here goes to a fake vpad
 * on loopback (a real TCP server speaking the daemon's one-line JSON
 * protocol) or to an injected `sendRaw`; no serial port is opened and no
 * python is spawned.
 *
 * Same sandbox as killswitch.machines.test.ts: a temp HOME, so the stop latch
 * and the machines registry read here are not the maintainer's.
 */
process.env.DPS_NO_BRIDGE ??= "1";

import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const realHome = { USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME };
const realDeckIp = process.env.DECK_IP;
const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "dps-press-deadline-"));
process.env.USERPROFILE = tempHome;
process.env.HOME = tempHome;
delete process.env.DECK_IP;

const { guardCall, pressDeadlineRefusal, reportCallStage } = await import("./callDeadline.js");
const { MachineCallQueue } = await import("./callQueue.js");
const { normalizeMachine, runWithMachine } = await import("./machines.js");
const { padPress, padChord, padRelease, padStatus } = await import("./deck/padClient.js");
const { pressButton, pressChord } = await import("./deck/pressButton.js");
const { walkTo } = await import("./deck/walkTo.js");
const { startFakeCdp, focusedPage } = await import("./deck/__testutil__/fakeCdp.js");

after(() => {
  process.env.USERPROFILE = realHome.USERPROFILE;
  process.env.HOME = realHome.HOME;
  if (realDeckIp === undefined) delete process.env.DECK_IP;
  else process.env.DECK_IP = realDeckIp;
  fs.rmSync(tempHome, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const quiet = () => {};

interface Written {
  cmd: Record<string, unknown>;
  at: number;
}

/** A fake vpad.py: records every command with its arrival time, acks quickly. */
function startFakePad(): Promise<{ port: number; written: Written[]; close: () => Promise<void> }> {
  const written: Written[] = [];
  const socks = new Set<net.Socket>();
  const server = net.createServer((sock) => {
    socks.add(sock);
    sock.setEncoding("utf8");
    let buf = "";
    sock.on("data", (d: string) => {
      buf += d;
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        const cmd = JSON.parse(line) as Record<string, unknown>;
        written.push({ cmd, at: Date.now() });
        sock.write(JSON.stringify({ ok: true, t: cmd.t }) + "\n");
      }
    });
    sock.on("error", () => {});
    sock.on("close", () => socks.delete(sock));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        port: (server.address() as net.AddressInfo).port,
        written,
        close: () =>
          new Promise<void>((r) => {
            for (const s of socks) s.destroy();
            server.close(() => r());
          }),
      });
    });
  });
}

/** Run `fn` as the body of a guarded call on `machine` with the given deadline, the way index.ts does. */
function guarded<T>(
  tool: string,
  machine: ReturnType<typeof normalizeMachine>,
  deadlineMs: number,
  fn: () => Promise<T>,
  queue?: InstanceType<typeof MachineCallQueue>,
): Promise<T> {
  return runWithMachine(machine, () =>
    guardCall({ tool, machine: machine.name, cls: "driving", deadlineMs, deadlineSource: "requested", queue, run: fn, log: quiet }),
  );
}

/** Clear DPS_NO_BRIDGE for one case that talks only to the fake pad on loopback. */
async function withBridge<T>(fn: () => Promise<T>): Promise<T> {
  const prior = process.env.DPS_NO_BRIDGE;
  delete process.env.DPS_NO_BRIDGE;
  try {
    return await fn();
  } finally {
    if (prior === undefined) delete process.env.DPS_NO_BRIDGE;
    else process.env.DPS_NO_BRIDGE = prior;
  }
}

test("outside a guarded call nothing is fenced", () => {
  assert.equal(pressDeadlineRefusal("press A"), null);
});

test("inside its deadline a call may press; after it, the refusal names the tool, the deadline and the stage", async () => {
  const m = normalizeMachine("fence", { kind: "standin", os: "windows", local: true, press: "vigem" });
  const seen: Array<string | null> = [];
  await assert.rejects(
    guarded("deck_walkTo", m, 80, async () => {
      reportCallStage("walk DOWN");
      seen.push(pressDeadlineRefusal("press DOWN"));
      await sleep(160);
      seen.push(pressDeadlineRefusal("press DOWN"));
    }),
    /did not finish within its deadline/,
  );
  // The abandoned body keeps running; give it its 160 ms.
  await sleep(200);
  assert.equal(seen[0], null);
  assert.ok(seen[1], "the late check must refuse");
  assert.match(seen[1]!, /Nothing was pressed/);
  assert.match(seen[1]!, /deck_walkTo's deadline of 80 ms/);
  assert.match(seen[1]!, /"press DOWN"/);
  assert.match(seen[1]!, /last stage it reported was "walk DOWN"/);
});

test("pad client: a press or chord from an expired call is never written; release and status still are", async () => {
  const pad = await startFakePad();
  const m = normalizeMachine("fence", { kind: "standin", os: "windows", local: true, press: "vigem", padPort: pad.port });
  try {
    const ep = { host: "127.0.0.1", port: pad.port };
    const out: Record<string, { ack: boolean; failure?: string }> = {};
    await assert.rejects(
      guarded("deck_sweep", m, 60, async () => {
        await sleep(120);
        const press = await padPress(ep, ["DOWN"], 20);
        const chord = await padChord(ep, "GUIDE", "A");
        const release = await padRelease(ep);
        const status = await padStatus(ep);
        out.press = { ack: press.ack != null, failure: press.failure };
        out.chord = { ack: chord.ack != null, failure: chord.failure };
        out.release = { ack: release.ack != null };
        out.status = { ack: status.ack != null };
      }),
      /did not finish within its deadline/,
    );
    await sleep(250);
    assert.equal(out.press.ack, false);
    assert.match(out.press.failure ?? "", /Nothing was pressed/);
    assert.equal(out.chord.ack, false);
    assert.match(out.chord.failure ?? "", /Nothing was pressed/);
    // The release after a timeout must still get through, and status presses nothing.
    assert.equal(out.release.ack, true);
    assert.equal(out.status.ack, true);
    assert.deepEqual(pad.written.map((w) => w.cmd.t), ["release", "status"], "no press or chord reached the pad");
  } finally {
    await pad.close();
  }
});

test("pressButton and pressChord on a virtual pad: an expired call writes nothing and says why, not 'pad unavailable'", async () => {
  const pad = await startFakePad();
  const m = normalizeMachine("fence", { kind: "standin", os: "windows", local: true, press: "vigem", padPort: pad.port });
  try {
    await withBridge(async () => {
      const results: Array<{ ok: boolean; reason?: string }> = [];
      await assert.rejects(
        guarded("deck_openPlugin", m, 60, async () => {
          await sleep(120);
          results.push(await pressButton({ buttons: ["DOWN"] }));
          results.push(await pressButton({ buttons: ["DOWN"], verify: true, cdpUrl: "http://127.0.0.1:1" }));
          results.push(await pressChord("GUIDE", "A"));
        }),
        /did not finish within its deadline/,
      );
      await sleep(250);
      assert.equal(results.length, 3);
      for (const r of results) {
        assert.equal(r.ok, false);
        assert.match(r.reason ?? "", /Nothing was pressed: deck_openPlugin's deadline of 60 ms/);
        assert.doesNotMatch(r.reason ?? "", /not available/);
      }
      assert.match(results[0].reason ?? "", /"press DOWN"/);
      assert.match(results[2].reason ?? "", /"chord GUIDE\+A"/);
      assert.equal(pad.written.length, 0, "the fake pad saw nothing");
    });
  } finally {
    await pad.close();
  }
});

test("a press inside the deadline still goes out, and reports its own stage", async () => {
  const pad = await startFakePad();
  const m = normalizeMachine("fence", { kind: "standin", os: "windows", local: true, press: "vigem", padPort: pad.port });
  try {
    await withBridge(async () => {
      const r = await guarded("deck_pressButton", m, 5_000, () => pressButton({ buttons: ["down"] }));
      assert.equal(r.ok, true, r.reason);
      assert.equal(r.fidelity, "wire-sent");
      assert.deepEqual(pad.written.map((w) => w.cmd.t), ["press"]);
    });
  } finally {
    await pad.close();
  }
});

test("sendRaw (the substituted delivery) is fenced too: an expired call never reaches it", async () => {
  const m = normalizeMachine("fence", { kind: "standin", os: "windows", local: true, press: "vigem" });
  let sent = 0;
  const sendRaw = async (o: { buttons: string[] }) => {
    sent++;
    return { ok: true, fidelity: "wire-sent" as const, method: "fake", buttons: o.buttons, holdMs: 80 };
  };
  const results: Array<{ ok: boolean; reason?: string }> = [];
  await assert.rejects(
    guarded("deck_runSequence", m, 50, async () => {
      results.push(await pressButton({ buttons: ["UP"], sendRaw }));
      await sleep(100);
      results.push(await pressButton({ buttons: ["UP"], sendRaw }));
    }),
    /did not finish within its deadline/,
  );
  await sleep(120);
  assert.equal(sent, 1, "only the press made inside the deadline reached the delivery");
  assert.equal(results[0].ok, true);
  assert.equal(results[1].ok, false);
  assert.match(results[1].reason ?? "", /deck_runSequence's deadline of 50 ms/);
});

test("a deck_walkTo whose deadline passes mid-walk cannot press beside the second call", async () => {
  const pad = await startFakePad();
  const m = normalizeMachine("fence", { kind: "standin", os: "windows", local: true, press: "vigem", padPort: pad.port });
  // Every read shows a different control, so the walk never stalls and never
  // finds its text: only the deadline can end it.
  const cdp = await startFakeCdp(["SharedJSContext"], (_t, i) => ({
    ...focusedPage,
    gpfocus: { ...focusedPage.gpfocus, selector: `#qa > button.Item${i}`, text: `Item ${i}`, ownerText: `Item ${i}` },
  }));
  const queue = new MachineCallQueue();
  try {
    await withBridge(async () => {
      let walkResult: Awaited<ReturnType<typeof walkTo>> | null = null;
      const t0 = Date.now();
      // ~200 ms per step (walkTo's own settle sleep): a 450 ms deadline lands mid-walk.
      const first = guarded(
        "deck_walkTo",
        m,
        450,
        async () => {
          walkResult = await walkTo({ direction: "DOWN", text: "never there", budget: 200, acquireFocus: false, cdpUrl: cdp.base });
          return walkResult;
        },
        queue,
      );
      await assert.rejects(first, /deck_walkTo did not finish within its deadline of 450 ms/);
      const rejectedAt = Date.now();
      assert.ok(rejectedAt - t0 >= 440);

      // The second call, queued behind nothing now, presses UP once.
      const second = await guarded("deck_pressButton", m, 5_000, () => pressButton({ buttons: ["UP"] }), queue);
      assert.equal(second.ok, true, second.reason);

      // Let the abandoned walk wake from its sleep, read, and try to press again.
      await sleep(700);

      const downsAfter = pad.written.filter((w) => w.at > rejectedAt && JSON.stringify(w.cmd.b) === '["DOWN"]');
      assert.equal(downsAfter.length, 0, "the abandoned walk wrote no DOWN after its deadline");
      const afterT = pad.written.filter((w) => w.at > rejectedAt).map((w) => JSON.stringify(w.cmd.b));
      assert.deepEqual(afterT, ['["UP"]'], "after the timeout the pad saw only the second call's press");
      const downsBefore = pad.written.filter((w) => w.at <= rejectedAt && JSON.stringify(w.cmd.b) === '["DOWN"]');
      assert.ok(downsBefore.length >= 1, "the walk really was pressing before its deadline");
      // And the abandoned walk ended on the refusal rather than running on.
      assert.ok(walkResult, "the abandoned walk returned");
      const wr = walkResult as Awaited<ReturnType<typeof walkTo>>;
      assert.equal(wr.ok, false);
      assert.match(wr.reason ?? "", /Nothing was pressed: deck_walkTo's deadline of 450 ms/);
    });
  } finally {
    await cdp.close();
    await pad.close();
  }
});

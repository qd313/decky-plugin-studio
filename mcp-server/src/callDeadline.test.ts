/**
 * Tests for the dispatch seam's guard (callDeadline.ts, plan 11 lane D).
 *
 * Fake tools go through guardCall(), the function index.ts handle() wraps
 * around every `tools/*` dispatch case, with the same queue/lease/release
 * wiring index.ts gives it. The crash-guard tests run in a child node process,
 * because node:test installs its own unhandledRejection/uncaughtException
 * listeners in this one and would report the stray error as a test failure.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  CallDeadlineError,
  DEFAULT_DEADLINE_MS,
  guardCall,
  installChildTracking,
  isStdioTransportError,
  PadRelease,
  reportCallStage,
  takeDeadlineArg,
} from "./callDeadline.js";
import { MachineCallQueue, QueueWaitTimeoutError } from "./callQueue.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const never = <T>(): Promise<T> => new Promise<T>(() => {});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const quiet = () => {};

function releaseSpy() {
  const calls: number[] = [];
  const release = async (): Promise<PadRelease> => {
    calls.push(Date.now());
    return { attempted: true, ok: true, detail: "fake board acknowledged the release" };
  };
  return { calls, release };
}

test("a driving tool that never resolves ends at its deadline with an honest error and one release", async () => {
  const { calls, release } = releaseSpy();
  let leaseFnSettled = false;
  const t0 = Date.now();
  await assert.rejects(
    guardCall({
      tool: "deck_walkTo",
      machine: "deck",
      cls: "driving",
      deadlineMs: 50,
      deadlineSource: "requested",
      queue: new MachineCallQueue(),
      // Stands in for withLease: its finally (the heartbeat's clearInterval)
      // runs only if the function it wraps settles.
      around: async (fn) => {
        try {
          return await fn();
        } finally {
          leaseFnSettled = true;
        }
      },
      release,
      log: quiet,
      run: async () => {
        reportCallStage("press Down 3 of 7");
        return never<unknown>();
      },
    }),
    (err: unknown) => {
      assert.ok(err instanceof CallDeadlineError, `expected CallDeadlineError, got ${String(err)}`);
      assert.match(err.message, /deck_walkTo did not finish within its deadline of 50 ms/);
      assert.match(err.message, /the deadlineMs this call passed/);
      assert.match(err.message, /last stage it reported was "press Down 3 of 7"/);
      assert.match(err.message, /abandoned, not cancelled/);
      assert.match(err.message, /stop latch was NOT set/);
      assert.match(err.message, /lease heartbeat has stopped/);
      assert.equal(err.release?.ok, true);
      return true;
    },
  );
  const took = Date.now() - t0;
  assert.ok(took < 1000, `the call should end near its 50 ms deadline, took ${took} ms`);
  assert.equal(calls.length, 1, "the release hook is called exactly once");
  assert.equal(leaseFnSettled, true, "the lease wrapper's finally ran, so the heartbeat stopped");
});

test("a read that never resolves times out without a release, and says it reports no stages", async () => {
  const { calls, release } = releaseSpy();
  await assert.rejects(
    guardCall({ tool: "deck_readFocus", machine: "deck", cls: "read", deadlineMs: 30, release: undefined, log: quiet, run: () => never() }),
    (err: unknown) => {
      assert.ok(err instanceof CallDeadlineError);
      assert.match(err.message, /default for read tools; pass deadlineMs to change it/);
      assert.match(err.message, /reports no stages/);
      assert.match(err.message, /not a driving tool, so no pad release was needed/);
      return true;
    },
  );
  assert.equal(calls.length, 0);
});

test("a tool that resolves in time is untouched: same object, no release", async () => {
  const { calls, release } = releaseSpy();
  const marker = Symbol("image");
  const value: Record<string | symbol, unknown> = { ok: true, focus: "Settings" };
  Object.defineProperty(value, marker, { value: "png", enumerable: false });
  const before = JSON.stringify(value);
  const got = await guardCall({
    tool: "deck_pressButton",
    machine: "deck",
    cls: "driving",
    deadlineMs: 500,
    queue: new MachineCallQueue(),
    release,
    log: quiet,
    run: async () => value,
  });
  assert.equal(got, value, "the very same object comes back");
  assert.equal(JSON.stringify(got), before, "no field was added to a call that did not wait");
  assert.equal((got as Record<symbol, unknown>)[marker], "png", "a non-enumerable picture survives");
  assert.equal(calls.length, 0);
});

test("a tool's own error passes through unchanged", async () => {
  const boom = new Error("lease refused: held by someone else");
  await assert.rejects(
    guardCall({ tool: "deck_pressButton", machine: "deck", cls: "driving", deadlineMs: 500, queue: new MachineCallQueue(), log: quiet, run: async () => { throw boom; } }),
    (err: unknown) => err === boom,
  );
});

test("two driving calls on machine X run serially, the second reports its wait, a read on X runs at once", async () => {
  const queue = new MachineCallQueue();
  const events: string[] = [];
  const first = guardCall({
    tool: "deck_sweep",
    machine: "X",
    cls: "driving",
    deadlineMs: 2000,
    queue,
    log: quiet,
    run: async () => {
      events.push("first start");
      await sleep(120);
      events.push("first end");
      return { ok: true, which: "first" };
    },
  });
  const second = guardCall({
    tool: "deck_pressButton",
    machine: "X",
    cls: "driving",
    deadlineMs: 2000,
    queue,
    log: quiet,
    run: async () => {
      events.push("second start");
      return { ok: true, which: "second" };
    },
  });
  await sleep(10);
  const readStart = Date.now();
  const read = await guardCall({
    tool: "deck_readFocus",
    machine: "X",
    cls: "read",
    deadlineMs: 2000,
    log: quiet,
    run: async () => {
      events.push("read");
      return { ok: true };
    },
  });
  assert.ok(Date.now() - readStart < 80, "the read did not wait behind the driving calls");
  assert.equal("waitedForPreviousCallMs" in read, false);
  const [r1, r2] = (await Promise.all([first, second])) as Array<Record<string, unknown>>;
  assert.deepEqual(events, ["first start", "read", "first end", "second start"]);
  assert.equal("waitedForPreviousCallMs" in r1, false, "the first call did not wait");
  assert.equal(typeof r2.waitedForPreviousCallMs, "number");
  assert.ok((r2.waitedForPreviousCallMs as number) >= 90, `second waited ${String(r2.waitedForPreviousCallMs)} ms`);
});

test("a driving call on machine Y does not wait for X", async () => {
  const queue = new MachineCallQueue();
  const onX = guardCall({ tool: "deck_sweep", machine: "X", cls: "driving", deadlineMs: 2000, queue, log: quiet, run: async () => { await sleep(150); return { ok: true }; } });
  const t0 = Date.now();
  const onY = (await guardCall({ tool: "deck_pressButton", machine: "Y", cls: "driving", deadlineMs: 2000, queue, log: quiet, run: async () => ({ ok: true }) })) as Record<string, unknown>;
  assert.ok(Date.now() - t0 < 80, "Y ran at once");
  assert.equal("waitedForPreviousCallMs" in onY, false);
  await onX;
});

test("calls queue first in, first out", async () => {
  const queue = new MachineCallQueue();
  const order: string[] = [];
  const call = (name: string, ms: number) =>
    guardCall({ tool: name, machine: "X", cls: "driving", deadlineMs: 2000, queue, log: quiet, run: async () => { order.push(name); await sleep(ms); return { name }; } });
  await Promise.all([call("a", 40), call("b", 10), call("c", 10), call("d", 10)]);
  assert.deepEqual(order, ["a", "b", "c", "d"]);
});

test("a queued call whose deadline passes while waiting never runs, and the line moves on", async () => {
  const queue = new MachineCallQueue();
  let ran = false;
  const first = guardCall({ tool: "deck_sweep", machine: "X", cls: "driving", deadlineMs: 2000, queue, log: quiet, run: async () => { await sleep(150); return { ok: true }; } });
  await assert.rejects(
    guardCall({ tool: "deck_pressButton", machine: "X", cls: "driving", deadlineMs: 40, queue, log: quiet, run: async () => { ran = true; return {}; } }),
    (err: unknown) => {
      assert.ok(err instanceof QueueWaitTimeoutError);
      assert.match(err.message, /deck_pressButton waited \d+ ms for deck_sweep to finish on machine "X"/);
      assert.match(err.message, /Nothing was sent by this call/);
      return true;
    },
  );
  await first;
  assert.equal(ran, false);
  assert.equal(queue.runningOn("X"), null, "nobody holds X after the line empties");
});

test("a timed-out driving call frees the machine for the next call", async () => {
  const queue = new MachineCallQueue();
  const { release } = releaseSpy();
  const hung = guardCall({ tool: "deck_walkTo", machine: "X", cls: "driving", deadlineMs: 40, queue, release, log: quiet, run: () => never() });
  const next = guardCall({ tool: "deck_pressButton", machine: "X", cls: "driving", deadlineMs: 2000, queue, release, log: quiet, run: async () => ({ ok: true }) });
  await assert.rejects(hung, CallDeadlineError);
  const r = (await next) as Record<string, unknown>;
  assert.equal(r.ok, true);
  assert.equal(typeof r.waitedForPreviousCallMs, "number");
});

test("an abandoned call that settles later is logged, not left as an unhandled rejection", async () => {
  const lines: string[] = [];
  await assert.rejects(
    guardCall({
      tool: "deck_launchGame",
      machine: "deck",
      cls: "read",
      deadlineMs: 20,
      log: (l) => lines.push(l),
      run: async () => {
        await sleep(60);
        throw new Error("late failure");
      },
    }),
    CallDeadlineError,
  );
  await sleep(100);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /abandoned deck_launchGame failed \d+ ms after its deadline/);
  assert.match(lines[0], /late failure/);
});

test("a child process the timed-out call spawned is killed", async () => {
  installChildTracking();
  let pid = 0;
  await assert.rejects(
    guardCall({
      tool: "deck_snapshotSettings",
      machine: "deck",
      cls: "driving",
      deadlineMs: 300,
      queue: new MachineCallQueue(),
      release: async () => ({ attempted: false, ok: true, detail: "fake" }),
      log: quiet,
      run: async () => {
        const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
        pid = child.pid ?? 0;
        return never();
      },
    }),
    (err: unknown) => {
      assert.ok(err instanceof CallDeadlineError);
      assert.equal(err.killedChildren.length, 1, err.message);
      assert.match(err.message, /Child processes it had started were killed/);
      return true;
    },
  );
  assert.ok(pid > 0);
  let alive = true;
  for (let i = 0; i < 40 && alive; i++) {
    try {
      process.kill(pid, 0);
      await sleep(50);
    } catch {
      alive = false;
    }
  }
  assert.equal(alive, false, `child pid ${pid} is still running after the deadline`);
});

test("deadlineMs is the seam's argument: stripped, validated, defaulted per class", () => {
  const a = takeDeadlineArg({ machine: "deck", deadlineMs: 1234, x: 1 }, "driving");
  assert.equal(a.deadlineMs, 1234);
  assert.equal(a.source, "requested");
  assert.deepEqual(a.rest, { machine: "deck", x: 1 });
  assert.equal(takeDeadlineArg({}, "driving").deadlineMs, 10 * 60_000);
  assert.equal(takeDeadlineArg({}, "read").deadlineMs, 60_000);
  assert.equal(takeDeadlineArg({}, "status").deadlineMs, 30_000);
  assert.equal(DEFAULT_DEADLINE_MS.status, 30_000);
  assert.throws(() => takeDeadlineArg({ deadlineMs: -5 }, "read"), /deadlineMs must be a positive number/);
  assert.throws(() => takeDeadlineArg({ deadlineMs: "soon" }, "read"), /deadlineMs must be a positive number/);
});

test("only an EPIPE-class error counts as the stdio transport failing", () => {
  assert.equal(isStdioTransportError(Object.assign(new Error("write EPIPE"), { code: "EPIPE" })), true);
  assert.equal(isStdioTransportError(new Error("ssh: connection refused")), false);
  assert.equal(isStdioTransportError("a string"), false);
});

// ---------------------------------------------------------------------------
// Process-level handlers, in a child process
// ---------------------------------------------------------------------------

function runChild(body: string): { status: number | null; stdout: string; stderr: string } {
  const url = pathToFileURL(path.join(here, "callDeadline.ts")).href;
  const script = `(async () => { const m = await import(${JSON.stringify(url)}); ${body} })();`;
  const r = spawnSync(process.execPath, ["--import", "tsx", "-e", script], {
    cwd: path.join(here, ".."),
    encoding: "utf8",
    timeout: 30_000,
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

test("a rejected promise and a thrown timer from fake tools are logged and the dispatcher answers the next call", () => {
  const r = runChild(`
    m.installCrashGuards();
    const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
    await m.guardCall({ tool: "fake_stray", machine: "X", cls: "read", deadlineMs: 2000, run: async () => {
      Promise.reject(new Error("stray boom"));
      setTimeout(() => { throw new Error("timer boom"); }, 5);
      await sleep(40);
      return { ok: true };
    } });
    await sleep(20);
    const next = await m.guardCall({ tool: "fake_next", machine: null, cls: "read", deadlineMs: 2000, run: async () => ({ answered: true }) });
    console.log("NEXT " + JSON.stringify(next));
  `);
  assert.equal(r.status, 0, `the process died (status ${r.status}):\n${r.stderr}`);
  assert.match(r.stdout, /NEXT \{"answered":true\}/);
  assert.match(r.stderr, /unhandledRejection caught and logged; the server stays up\. Tools in flight: fake_stray/);
  assert.match(r.stderr, /stray boom/);
  assert.match(r.stderr, /uncaughtException caught and logged/);
  assert.match(r.stderr, /timer boom/);
});

test("an error in the stdio transport itself still exits", () => {
  const r = runChild(`
    m.installCrashGuards();
    setTimeout(() => { throw Object.assign(new Error("write EPIPE"), { code: "EPIPE" }); }, 5);
    setTimeout(() => console.log("STILL HERE"), 200);
  `);
  assert.equal(r.status, 1);
  assert.doesNotMatch(r.stdout, /STILL HERE/);
  assert.match(r.stderr, /in the stdio transport/);
});

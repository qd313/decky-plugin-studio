/**
 * Tests for the per-machine driving-call queue (callQueue.ts, plan 11 lane D).
 * The queue as wired through the seam is covered in callDeadline.test.ts.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { MachineCallQueue, QueueWaitTimeoutError } from "./callQueue.js";

test("an idle machine is taken at once and reports no wait", async () => {
  const q = new MachineCallQueue();
  const s = await q.acquire("deck", "deck_pressButton", 100);
  assert.equal(s.queued, false);
  assert.equal(s.waitedMs, 0);
  assert.equal(q.runningOn("deck"), "deck_pressButton");
  s.release();
  assert.equal(q.runningOn("deck"), null);
});

test("waiters start in arrival order and name what they waited behind", async () => {
  const q = new MachineCallQueue();
  const a = await q.acquire("deck", "a", 1000);
  const pb = q.acquire("deck", "b", 1000);
  const pc = q.acquire("deck", "c", 1000);
  assert.equal(q.waitingOn("deck"), 2);
  a.release();
  const b = await pb;
  assert.equal(b.queued, true);
  assert.equal(b.waitedBehind, "a");
  assert.equal(q.runningOn("deck"), "b");
  b.release();
  b.release(); // idempotent: must not hand the machine on twice
  const c = await pc;
  assert.equal(c.waitedBehind, "b");
  assert.equal(q.runningOn("deck"), "c");
  c.release();
  assert.equal(q.runningOn("deck"), null);
});

test("a waiter that times out leaves the line and is never started", async () => {
  const q = new MachineCallQueue();
  const a = await q.acquire("deck", "a", 1000);
  await assert.rejects(q.acquire("deck", "b", 20), QueueWaitTimeoutError);
  assert.equal(q.waitingOn("deck"), 0);
  a.release();
  assert.equal(q.runningOn("deck"), null);
});

test("machines are independent lanes", async () => {
  const q = new MachineCallQueue();
  await q.acquire("deck", "a", 1000);
  const y = await q.acquire("bazzite-vm", "b", 1000);
  assert.equal(y.queued, false);
});

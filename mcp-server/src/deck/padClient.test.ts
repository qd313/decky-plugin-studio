/**
 * Tests for the virtual pad client (padClient.ts) against a fake vpad.py: a
 * real TCP server on loopback speaking the daemon's one-line JSON protocol.
 * No device is created anywhere; the fake only answers.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";

import { padPress, padChord, padRelease, padStatus, padRequest, ackLine } from "./padClient.js";

interface FakePad {
  port: number;
  received: Record<string, unknown>[];
  close: () => Promise<void>;
}

/** A fake daemon. `behaviour` decides what each command gets back. */
function startFakePad(
  behaviour: (cmd: Record<string, unknown>, sock: net.Socket) => void = defaultBehaviour,
): Promise<FakePad> {
  const received: Record<string, unknown>[] = [];
  const server = net.createServer((sock) => {
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
        received.push(cmd);
        behaviour(cmd, sock);
      }
    });
    sock.on("error", () => {});
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as net.AddressInfo).port;
      resolve({
        port,
        received,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

function defaultBehaviour(cmd: Record<string, unknown>, sock: net.Socket): void {
  const reply = (o: unknown) => sock.write(JSON.stringify(o) + "\n");
  switch (cmd.t) {
    case "status":
      reply({ ok: true, t: "status", backend: "fake", held: [], watchdog_ms: 750 });
      break;
    case "press": {
      // Like the real daemon: an event line first, the ack after the hold.
      reply({ event: "note", detail: "pressing" });
      setTimeout(() => reply({ ok: true, t: "press", b: cmd.b, ms: cmd.ms }), Number(cmd.ms ?? 80));
      break;
    }
    case "chord":
      reply({ ok: true, t: "chord", hold: cmd.hold, tap: cmd.tap });
      break;
    case "release":
      reply({ ok: true, t: "release" });
      break;
    default:
      reply({ ok: false, t: String(cmd.t), err: "unknown command" });
  }
}

const open: FakePad[] = [];
after(async () => {
  for (const f of open) await f.close();
});

test("padPress sends the firmware-shaped command and returns the ack, skipping event lines", async () => {
  const fake = await startFakePad();
  open.push(fake);
  const x = await padPress({ host: "127.0.0.1", port: fake.port }, ["A"], 40);
  assert.ok(x.ack);
  assert.equal(x.ack!.ok, true);
  assert.equal(x.ack!.t, "press");
  assert.deepEqual(fake.received[0], { t: "press", b: ["A"], ms: 40 });
  assert.equal(x.lines.length, 2, "the event line and the ack were both kept for post-mortems");
  assert.match(ackLine(x)!, /"t":"press"/);
});

test("padChord, padRelease and padStatus each wait for their own ack", async () => {
  const fake = await startFakePad();
  open.push(fake);
  const ep = { host: "127.0.0.1", port: fake.port };
  const c = await padChord(ep, "GUIDE", "A");
  assert.equal(c.ack?.t, "chord");
  const r = await padRelease(ep);
  assert.equal(r.ack?.t, "release");
  const s = await padStatus(ep);
  assert.equal(s.ack?.backend, "fake");
});

test("a refusal from the daemon comes back as an ack with ok:false and its reason", async () => {
  const fake = await startFakePad();
  open.push(fake);
  const x = await padRequest({ host: "127.0.0.1", port: fake.port }, { t: "dance" });
  assert.equal(x.ack?.ok, false);
  assert.equal(x.ack?.err, "unknown command");
});

test("nothing listening: resolves with a failure, never throws", async () => {
  // Grab a port and close it so nothing is listening there.
  const probe = await startFakePad();
  await probe.close();
  const x = await padStatus({ host: "127.0.0.1", port: probe.port }, 1500);
  assert.equal(x.ack, null);
  assert.match(x.failure!, /vpad at 127\.0\.0\.1:\d+/);
});

test("a daemon that hangs up before acknowledging is reported as such", async () => {
  const fake = await startFakePad((cmd, sock) => {
    if (cmd.t === "press") sock.end();
  });
  open.push(fake);
  const x = await padPress({ host: "127.0.0.1", port: fake.port }, ["A"], 20);
  assert.equal(x.ack, null);
  assert.match(x.failure!, /closed the connection before acknowledging "press"/);
});

test("a daemon that never answers times out with the command named", async () => {
  const fake = await startFakePad(() => {
    /* say nothing */
  });
  open.push(fake);
  const x = await padRequest({ host: "127.0.0.1", port: fake.port }, { t: "status" }, 200);
  assert.equal(x.ack, null);
  assert.match(x.failure!, /did not acknowledge "status" within 200ms/);
});

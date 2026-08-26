/**
 * Tests for the CDP client and the focus oracle.
 *
 * These run against a fake CDP server started in-process, so they need no Deck
 * and no network. That matters for two reasons: the hand-rolled WebSocket
 * framing in ws.ts is the riskiest code in this feature and needs a real
 * round-trip to prove it, and anyone without a Steam Deck still has to be able
 * to run the suite.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import crypto from "node:crypto";
import type { Socket } from "node:net";

import { evaluate, listTargets, getVersion, rewriteWsHost } from "./cdp.js";
import { readFocusAt } from "./readFocus.js";
import { pressButton, findPadTool } from "./pressButton.js";
import { assertFocusMove } from "./assertFocusMove.js";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

interface Fake {
  base: string;
  close: () => Promise<void>;
}

/**
 * A CDP server just real enough to answer /json/list, /json/version and one
 * Runtime.evaluate. The evaluate reply is whatever `pageValue(targetTitle)`
 * returns, so a test can make one target carry gpfocus and the rest not.
 */
async function startFakeCdp(
  targetTitles: string[],
  pageValue: (title: string) => unknown,
): Promise<Fake> {
  const sockets = new Set<Socket>();

  const server = http.createServer((req, res) => {
    if (req.url === "/json/version") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ Browser: "Chrome/126.0.0.0", "Protocol-Version": "1.3" }));
      return;
    }
    if (req.url === "/json/list") {
      const port = (server.address() as { port: number }).port;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify(
          targetTitles.map((title, i) => ({
            id: `T${i}`,
            type: "page",
            title,
            url: `about:blank?t=${i}`,
            webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/T${i}`,
          })),
        ),
      );
      return;
    }
    res.writeHead(404);
    res.end();
  });

  server.on("upgrade", (req, socket: Socket) => {
    sockets.add(socket);
    const key = req.headers["sec-websocket-key"] as string;
    const accept = crypto
      .createHash("sha1")
      .update(key + GUID)
      .digest("base64");
    socket.write(
      [
        "HTTP/1.1 101 Switching Protocols",
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Accept: ${accept}`,
        "\r\n",
      ].join("\r\n"),
    );

    const idx = Number(/\/page\/T(\d+)$/.exec(req.url ?? "")?.[1] ?? 0);
    const title = targetTitles[idx];

    socket.on("data", (chunk: Buffer) => {
      // Decode one masked client text frame. Enough for these tests.
      const len0 = chunk[1] & 0x7f;
      let offset = 2;
      let len = len0;
      if (len0 === 126) {
        len = chunk.readUInt16BE(2);
        offset = 4;
      } else if (len0 === 127) {
        len = Number(chunk.readBigUInt64BE(2));
        offset = 10;
      }
      const mask = chunk.subarray(offset, offset + 4);
      offset += 4;
      const payload = Buffer.alloc(len);
      for (let i = 0; i < len; i++) payload[i] = chunk[offset + i] ^ mask[i % 4];

      let id = 1;
      try {
        id = JSON.parse(payload.toString("utf8")).id ?? 1;
      } catch {
        /* keep the default */
      }

      const body = Buffer.from(
        JSON.stringify({ id, result: { result: { value: pageValue(title) } } }),
        "utf8",
      );

      // Unmasked server text frame, with the 16-bit length path exercised for
      // anything over 125 bytes -- which every real reply here is.
      let header: Buffer;
      if (body.length < 126) {
        header = Buffer.from([0x81, body.length]);
      } else if (body.length < 65536) {
        header = Buffer.alloc(4);
        header[0] = 0x81;
        header[1] = 126;
        header.writeUInt16BE(body.length, 2);
      } else {
        header = Buffer.alloc(10);
        header[0] = 0x81;
        header[1] = 127;
        header.writeBigUInt64BE(BigInt(body.length), 2);
      }
      socket.write(Buffer.concat([header, body]));
    });

    socket.on("error", () => sockets.delete(socket));
    socket.on("close", () => sockets.delete(socket));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;

  return {
    base: `http://127.0.0.1:${port}`,
    close: async () => {
      for (const s of sockets) s.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

const focusedPage = {
  hasGpfocus: true,
  elementCount: 289,
  gpfocus: {
    selector: "#quickaccess_content_999 > button.DialogButton",
    selectorVerified: true,
    tag: "BUTTON",
    id: null,
    classes: ["DialogButton", "Focusable", "gpfocus"],
    ariaLabel: null,
    text: "bonsAI",
    rect: { x: 64, y: 74, w: 268, h: 46 },
  },
  gpfocusWithin: [],
  activeElement: {
    selector: "#other",
    selectorVerified: true,
    tag: "DIV",
    id: "other",
    classes: [],
    ariaLabel: null,
    text: "something else",
    rect: null,
  },
  agree: false,
  quickAccessTab: "999",
  deckyPluginRoot: true,
};

const unfocusedPage = {
  hasGpfocus: false,
  elementCount: 15,
  gpfocus: null,
  gpfocusWithin: [],
  activeElement: null,
  agree: false,
  quickAccessTab: null,
  deckyPluginRoot: false,
};

test("lists targets and reads the browser version", async () => {
  const fake = await startFakeCdp(["SharedJSContext"], () => unfocusedPage);
  try {
    const targets = await listTargets(fake.base);
    assert.equal(targets.length, 1);
    assert.equal(targets[0].title, "SharedJSContext");
    const v = await getVersion(fake.base);
    assert.match(v.browser ?? "", /Chrome/);
  } finally {
    await fake.close();
  }
});

test("Runtime.evaluate round-trips through the hand-rolled websocket", async () => {
  const fake = await startFakeCdp(["OnlyTarget"], () => focusedPage);
  try {
    const [t] = await listTargets(fake.base);
    const value = await evaluate<typeof focusedPage>(
      rewriteWsHost(t.webSocketDebuggerUrl!, fake.base),
      "1",
    );
    // A reply well over 125 bytes, so the 16-bit length path is what carried it.
    assert.equal(value.hasGpfocus, true);
    assert.equal(value.gpfocus?.text, "bonsAI");
  } finally {
    await fake.close();
  }
});

test("finds the target that carries gpfocus, not the first one", async () => {
  // Deliberately mirrors the live Deck: SharedJSContext is listed first and is
  // empty; the QAM target is the one that actually owns focus.
  const fake = await startFakeCdp(["SharedJSContext", "MainMenu_uid2", "QuickAccess_uid2"], (t) =>
    t === "QuickAccess_uid2" ? focusedPage : unfocusedPage,
  );
  try {
    const r = await readFocusAt(fake.base);
    assert.equal(r.ok, true);
    assert.equal(r.method, "cdp:QuickAccess_uid2");
    assert.equal(r.fidelity, "steam-owned");
    assert.deepEqual(r.targetsScanned, [
      "SharedJSContext",
      "MainMenu_uid2",
      "QuickAccess_uid2",
    ]);
  } finally {
    await fake.close();
  }
});

test("reports the gpfocus/activeElement disagreement", async () => {
  const fake = await startFakeCdp(["QuickAccess_uid2"], () => focusedPage);
  try {
    const r = await readFocusAt(fake.base);
    assert.equal(r.agree, false, "the trap: Steam and the browser disagree");
    assert.equal(r.gpfocus?.text, "bonsAI");
    assert.equal(r.activeElement?.text, "something else");
    assert.equal(r.deckyPluginRoot, true);
    assert.equal(r.quickAccessTab, "999");
  } finally {
    await fake.close();
  }
});

test("no gpfocus anywhere fails loudly rather than reporting null focus", async () => {
  // A renamed Steam class must never read as "nothing is focused".
  const fake = await startFakeCdp(["SharedJSContext", "MainMenu_uid2"], () => unfocusedPage);
  try {
    const r = await readFocusAt(fake.base);
    assert.equal(r.ok, false);
    assert.match(r.reason ?? "", /gpfocus marker not found/);
    assert.match(r.reason ?? "", /SharedJSContext, MainMenu_uid2/);
    assert.equal(r.fidelity, null);
  } finally {
    await fake.close();
  }
});

test("an unreachable endpoint returns the preflight remediation, not a socket error", async () => {
  const r = await readFocusAt("http://127.0.0.1:1", 1500);
  assert.equal(r.ok, false);
  assert.match(r.reason ?? "", /cef-enable-remote-debugging/);
  assert.match(r.reason ?? "", /ssh -N -L 8080/);
});

test("rewriteWsHost points a target's own address at the tunnel we dialled", () => {
  assert.equal(
    rewriteWsHost("ws://127.0.0.1:8080/devtools/page/AB", "http://127.0.0.1:18080"),
    "ws://127.0.0.1:18080/devtools/page/AB",
  );
});

// --------------------------------------------------------------------------
// Press + assert. These cover the refusal paths, which are the ones that must
// never quietly degrade -- a synthetic press that "succeeds" is the exact bug
// this feature exists to remove. The happy path needs a Deck and a bridge and
// is verified on hardware instead.
// --------------------------------------------------------------------------

test("pressButton refuses an unknown button instead of guessing", async () => {
  const r = await pressButton({ buttons: ["DIAGONAL"] });
  assert.equal(r.ok, false);
  assert.equal(r.fidelity, null);
  assert.match(r.reason ?? "", /Unknown button/);
  assert.match(r.reason ?? "", /UP, DOWN, LEFT, RIGHT/);
});

test("pressButton refuses an empty press", async () => {
  const r = await pressButton({ buttons: [] });
  assert.equal(r.ok, false);
  assert.match(r.reason ?? "", /No buttons given/);
});

test("pressButton normalises case before validating", async () => {
  // "down" is a real button; the refusal must not be about the name.
  const r = await pressButton({ buttons: ["down"], timeoutMs: 1 });
  assert.equal(r.buttons[0], "DOWN");
  assert.doesNotMatch(r.reason ?? "", /Unknown button/);
});

test("the bridge tool is findable from the built server", () => {
  // If this breaks, every press refuses with a confusing "not found" message.
  assert.ok(findPadTool(), "bridge/tools/pad.py should be locatable by walking up");
});

test("assertFocusMove refuses when the Deck cannot be reached", async () => {
  const r = await assertFocusMove({ press: "DOWN", cdpUrl: "http://127.0.0.1:1" });
  assert.equal(r.ok, false);
  assert.equal(r.moved, false);
  assert.equal(r.fidelity, null);
  assert.match(r.diagnosis, /nothing was pressed/);
});

test("assertFocusMove refuses when no real press can be delivered", async () => {
  // Focus reads fine; the press is what fails. Nothing may be concluded about
  // the wiring from that, and the result must say so rather than report a move.
  const fake = await startFakeCdp(["QuickAccess_uid2"], () => focusedPage);
  try {
    const r = await assertFocusMove({
      press: "NOT_A_BUTTON",
      cdpUrl: fake.base,
    });
    assert.equal(r.ok, false);
    assert.equal(r.moved, false);
    assert.equal(r.fidelity, null);
    assert.ok(r.before?.ok, "focus before the press was read successfully");
    assert.match(r.diagnosis, /no press was delivered/);
    assert.match(r.reason ?? "", /Unknown button/);
  } finally {
    await fake.close();
  }
});

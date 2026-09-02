/**
 * A CDP server just real enough for the deck tests: /json/list, /json/version
 * and Runtime.evaluate over a real WebSocket upgrade.
 *
 * Shared by cdp.test.ts and runSequence.test.ts. It matters that this speaks
 * actual RFC 6455 framing rather than mocking the client, because the
 * hand-rolled WebSocket in ws.ts is the riskiest code in this feature and only
 * a real round-trip proves it. It also means anyone without a Steam Deck can
 * still run the suite.
 *
 * Not a *.test.ts file on purpose -- the runner discovers those, and this
 * exports helpers rather than tests.
 */
import http from "node:http";
import crypto from "node:crypto";
import type { Socket } from "node:net";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export interface Fake {
  base: string;
  /** How many Runtime.evaluate calls have been served. */
  evaluations: () => number;
  /** How many /json/list calls have been served -- a settle loop's poll count. */
  lists: () => number;
  close: () => Promise<void>;
}

/**
 * `pageValue` is called per evaluate with the target's title and a 0-based read
 * counter, so a test can make focus change between reads -- which is what the
 * sequence runner's settle loop and cycle detector need to exercise.
 */
export async function startFakeCdp(
  targetTitles: string[] | (() => string[]),
  pageValue: (title: string, readIndex: number) => unknown,
): Promise<Fake> {
  const sockets = new Set<Socket>();
  let reads = 0;
  let lists = 0;
  // A function lets a test change the target list between /json/list calls:
  // the shape of the seconds after a plugin_loader restart, when CEF names
  // only SharedJSContext until Steam has rebuilt its UI pages (issue #3).
  const titles = (): string[] => (typeof targetTitles === "function" ? targetTitles() : targetTitles);

  const server = http.createServer((req, res) => {
    if (req.url === "/json/version") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ Browser: "Chrome/126.0.0.0", "Protocol-Version": "1.3" }));
      return;
    }
    if (req.url === "/json/list") {
      lists++;
      const port = (server.address() as { port: number }).port;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify(
          titles().map((title, i) => ({
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
    const title = titles()[idx];

    socket.on("data", (chunk: Buffer) => {
      /*
       * Only TEXT frames are commands.
       *
       * This used to answer whatever arrived, which meant the close frame the
       * client sends on disconnect was decoded as another Runtime.evaluate and
       * silently consumed a reply. A poller then saw every second value: three
       * evaluations came back as two polls. Real Chrome ignores a close frame
       * here, and a test double that miscounts is worse than no double at all.
       */
      const opcode = chunk[0] & 0x0f;
      if (opcode !== 0x1) return;

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

      // A pageValue of { __throw: "..." } comes back as a real CDP
      // exceptionDetails, so the "expression threw in the page" path can be
      // tested without asking this fake to actually evaluate JavaScript.
      const produced = pageValue(title, reads++) as { __throw?: string } | unknown;
      const thrown =
        produced && typeof produced === "object" && "__throw" in (produced as object)
          ? (produced as { __throw?: string }).__throw
          : undefined;
      const reply = thrown
        ? { id, result: { exceptionDetails: { text: "Uncaught", exception: { description: thrown } } } }
        : { id, result: { result: { value: produced } } };
      const body = Buffer.from(JSON.stringify(reply), "utf8");

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
    evaluations: () => reads,
    lists: () => lists,
    close: async () => {
      for (const s of sockets) s.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** A page where the ring sits on a Decky list row labelled "bonsAI". */
export const focusedPage = {
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
    ownerText: "bonsAI",
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
    ownerText: "something else",
    rect: null,
  },
  agree: false,
  quickAccessTab: "999",
  visibleQuickAccessTab: "999",
  deckyPluginRoot: true,
};

/** A page with no gamepad focus owner anywhere. */
export const unfocusedPage = {
  hasGpfocus: false,
  elementCount: 15,
  gpfocus: null,
  gpfocusWithin: [],
  activeElement: null,
  agree: false,
  quickAccessTab: null,
  visibleQuickAccessTab: null,
  deckyPluginRoot: false,
};

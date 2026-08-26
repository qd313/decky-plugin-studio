/**
 * A minimal WebSocket client, enough to speak CDP and nothing more.
 *
 * Why hand-rolled. The MCP server ships inside the VSIX and runs on whatever
 * Node VS Code provides -- `engines.vscode` is ^1.85, which is Node 18, where
 * there is no global WebSocket. `ws` is not a dependency of this repo and
 * adding one to the shipped server is a bigger commitment than the ~150 lines
 * below. This speaks ws:// to 127.0.0.1 only, which is all a CDP tunnel needs.
 *
 * Scope, deliberately small: text frames, ping/pong, close, and fragmentation.
 * No TLS, no extensions, no permessage-deflate, no subprotocols.
 */
import net from "net";
import crypto from "crypto";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export interface WsOptions {
  timeoutMs?: number;
}

export class MiniWebSocket {
  private socket: net.Socket;
  private buffer = Buffer.alloc(0);
  private fragments: Buffer[] = [];
  private fragmentOpcode = 0;
  private messageHandlers: Array<(text: string) => void> = [];
  private closeHandlers: Array<(reason: string) => void> = [];
  private closed = false;

  private constructor(socket: net.Socket) {
    this.socket = socket;
    this.socket.on("data", (chunk) => this.onData(chunk));
    this.socket.on("close", () => this.fireClose("socket closed"));
    this.socket.on("error", (err) => this.fireClose(`socket error: ${err.message}`));
  }

  static connect(url: string, opts: WsOptions = {}): Promise<MiniWebSocket> {
    const timeoutMs = opts.timeoutMs ?? 10_000;
    const parsed = new URL(url);
    if (parsed.protocol !== "ws:") {
      return Promise.reject(new Error(`only ws:// is supported, got ${parsed.protocol}`));
    }
    const port = Number(parsed.port || 80);
    const pathname = `${parsed.pathname}${parsed.search}`;
    const key = crypto.randomBytes(16).toString("base64");
    const expectedAccept = crypto
      .createHash("sha1")
      .update(key + GUID)
      .digest("base64");

    return new Promise((resolve, reject) => {
      const socket = net.connect({ host: parsed.hostname, port });
      let settled = false;
      let handshake = Buffer.alloc(0);

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        socket.destroy();
        reject(new Error(`websocket handshake timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      const fail = (err: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        reject(err);
      };

      socket.on("error", fail);

      socket.on("connect", () => {
        socket.write(
          [
            `GET ${pathname} HTTP/1.1`,
            `Host: ${parsed.host}`,
            "Upgrade: websocket",
            "Connection: Upgrade",
            `Sec-WebSocket-Key: ${key}`,
            "Sec-WebSocket-Version: 13",
            "\r\n",
          ].join("\r\n"),
        );
      });

      const onHandshakeData = (chunk: Buffer): void => {
        handshake = Buffer.concat([handshake, chunk]);
        const end = handshake.indexOf("\r\n\r\n");
        if (end === -1) return;

        const header = handshake.subarray(0, end).toString("latin1");
        const rest = handshake.subarray(end + 4);

        if (!/^HTTP\/1\.1 101/i.test(header)) {
          const status = header.split("\r\n")[0] ?? "(no status line)";
          fail(new Error(`websocket upgrade refused: ${status}`));
          return;
        }
        const accept = /sec-websocket-accept:\s*(\S+)/i.exec(header)?.[1];
        if (accept !== expectedAccept) {
          fail(new Error("websocket handshake failed: Sec-WebSocket-Accept mismatch"));
          return;
        }

        settled = true;
        clearTimeout(timer);
        socket.removeListener("data", onHandshakeData);
        socket.removeListener("error", fail);

        const ws = new MiniWebSocket(socket);
        if (rest.length > 0) ws.onData(rest);
        resolve(ws);
      };

      socket.on("data", onHandshakeData);
    });
  }

  onMessage(cb: (text: string) => void): void {
    this.messageHandlers.push(cb);
  }

  onClose(cb: (reason: string) => void): void {
    this.closeHandlers.push(cb);
  }

  send(text: string): void {
    if (this.closed) throw new Error("websocket is closed");
    this.socket.write(this.encode(Buffer.from(text, "utf8"), 0x1));
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.socket.write(this.encode(Buffer.alloc(0), 0x8));
    } catch {
      // Already gone. Nothing to report -- close is best effort.
    }
    this.socket.destroy();
  }

  /** Client frames MUST be masked (RFC 6455 §5.3). */
  private encode(payload: Buffer, opcode: number): Buffer {
    const mask = crypto.randomBytes(4);
    const len = payload.length;
    let header: Buffer;

    if (len < 126) {
      header = Buffer.alloc(2);
      header[1] = 0x80 | len;
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[1] = 0x80 | 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[1] = 0x80 | 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    header[0] = 0x80 | opcode; // FIN

    const masked = Buffer.alloc(len);
    for (let i = 0; i < len; i++) masked[i] = payload[i] ^ mask[i % 4];

    return Buffer.concat([header, mask, masked]);
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);

    // Parse as many whole frames as the buffer currently holds. A partial frame
    // stays buffered until the rest of it arrives -- CDP replies routinely span
    // several TCP reads.
    for (;;) {
      if (this.buffer.length < 2) return;

      const b0 = this.buffer[0];
      const b1 = this.buffer[1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let offset = 2;

      if (len === 126) {
        if (this.buffer.length < offset + 2) return;
        len = this.buffer.readUInt16BE(offset);
        offset += 2;
      } else if (len === 127) {
        if (this.buffer.length < offset + 8) return;
        const big = this.buffer.readBigUInt64BE(offset);
        if (big > BigInt(Number.MAX_SAFE_INTEGER)) {
          this.fireClose("frame larger than this client will assemble");
          return;
        }
        len = Number(big);
        offset += 8;
      }

      if (masked) offset += 4; // servers should not mask, but do not misparse if one does
      if (this.buffer.length < offset + len) return;

      let payload = this.buffer.subarray(offset, offset + len);
      if (masked) {
        const mask = this.buffer.subarray(offset - 4, offset);
        const out = Buffer.alloc(len);
        for (let i = 0; i < len; i++) out[i] = payload[i] ^ mask[i % 4];
        payload = out;
      }
      this.buffer = this.buffer.subarray(offset + len);

      this.handleFrame(fin, opcode, payload);
    }
  }

  private handleFrame(fin: boolean, opcode: number, payload: Buffer): void {
    if (opcode === 0x8) {
      this.fireClose("peer sent close");
      return;
    }
    if (opcode === 0x9) {
      this.socket.write(this.encode(payload, 0xa)); // pong
      return;
    }
    if (opcode === 0xa) return; // pong

    if (opcode === 0x0) {
      this.fragments.push(payload);
    } else {
      this.fragments = [payload];
      this.fragmentOpcode = opcode;
    }

    if (!fin) return;

    const full = Buffer.concat(this.fragments);
    this.fragments = [];
    if (this.fragmentOpcode !== 0x1) return; // binary frames are not CDP

    const text = full.toString("utf8");
    for (const cb of this.messageHandlers) cb(text);
  }

  private fireClose(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    for (const cb of this.closeHandlers) cb(reason);
  }
}

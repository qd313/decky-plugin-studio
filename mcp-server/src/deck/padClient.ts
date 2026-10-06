/**
 * Client for bridge/tools/vpad.py -- the virtual gamepad that stands in for
 * the ESP32 board on machines the board cannot be plugged into (plan 10 § 5
 * item 4).
 *
 * vpad.py speaks the SAME one-JSON-object-per-line protocol as the board's
 * firmware (`{"t":"press","b":["A"],"ms":80}` -> `{"ok":true,"t":"press"}`),
 * over a TCP socket bound to 127.0.0.1 on the machine it runs on. On a Linux
 * stand-in it opens /dev/uinput and presents an Xbox 360 class pad; on this
 * Windows PC it drives a ViGEmBus pad. Either way Steam sees a controller
 * and routes its presses through Steam Input, exactly as it does the board.
 *
 * Reaching the socket: a `local` machine is 127.0.0.1:<padPort> directly; a
 * remote one is forwarded alongside the CDP port on the shared SSH tunnel
 * (cdpTunnel.ts), so a press is one TCP round trip from this process and no
 * python is spawned on the host at all.
 *
 * Fidelity keeps its meaning. An ack here means the daemon wrote the events
 * to the virtual device -- `wire-sent`, nothing more. Whether Steam picked
 * the device up is what `verify: true` measures, by reading focus before and
 * after, the same as for the board.
 *
 * `connect` goes through the mutable `proc` object so tests can fake the
 * daemon without a socket, the same seam pattern as cdpTunnel.ts.
 */
import net from "net";

export interface PadEndpoint {
  host: string;
  port: number;
}

export interface PadAck {
  ok: boolean;
  t?: string;
  err?: string;
  [k: string]: unknown;
}

export interface PadExchange {
  ack: PadAck | null;
  /** Every line the daemon sent, for post-mortems. */
  lines: string[];
  /** Set when no ack arrived: why. */
  failure?: string;
}

export const proc = {
  connect: (ep: PadEndpoint): net.Socket => net.connect({ host: ep.host, port: ep.port }),
};

/**
 * Send one command and wait for the ack whose "t" matches. Resolves rather
 * than rejects on every failure, so callers can turn it into a refusal with
 * the daemon's own words in it.
 */
export function padRequest(ep: PadEndpoint, cmd: Record<string, unknown>, timeoutMs = 5_000): Promise<PadExchange> {
  const want = String(cmd.t ?? "");
  return new Promise((resolve) => {
    const lines: string[] = [];
    let buf = "";
    let done = false;
    let sock: net.Socket;
    const finish = (r: PadExchange): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        sock.destroy();
      } catch {
        /* already gone */
      }
      resolve(r);
    };
    const timer = setTimeout(
      () => finish({ ack: null, lines, failure: `vpad at ${ep.host}:${ep.port} did not acknowledge "${want}" within ${timeoutMs}ms` }),
      timeoutMs,
    );
    try {
      sock = proc.connect(ep);
    } catch (err) {
      clearTimeout(timer);
      resolve({ ack: null, lines, failure: `could not connect to vpad at ${ep.host}:${ep.port}: ${(err as Error).message}` });
      return;
    }
    sock.setEncoding("utf8");
    sock.on("error", (e) => finish({ ack: null, lines, failure: `vpad at ${ep.host}:${ep.port}: ${e.message}` }));
    sock.on("close", () => finish({ ack: null, lines, failure: `vpad at ${ep.host}:${ep.port} closed the connection before acknowledging "${want}"` }));
    sock.on("connect", () => {
      sock.write(JSON.stringify(cmd) + "\n");
    });
    sock.on("data", (d: string) => {
      buf += d;
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        lines.push(line);
        let parsed: PadAck;
        try {
          parsed = JSON.parse(line) as PadAck;
        } catch {
          continue;
        }
        if (parsed && typeof parsed === "object" && "ok" in parsed && (parsed.t === want || !parsed.t)) {
          finish({ ack: parsed, lines });
          return;
        }
      }
    });
  });
}

export function padPress(ep: PadEndpoint, buttons: string[], holdMs: number, timeoutMs?: number): Promise<PadExchange> {
  return padRequest(ep, { t: "press", b: buttons, ms: holdMs }, timeoutMs ?? Math.max(5_000, holdMs + 3_000));
}

export function padChord(ep: PadEndpoint, hold: string, tap: string, timeoutMs = 8_000): Promise<PadExchange> {
  return padRequest(ep, { t: "chord", hold, tap }, timeoutMs);
}

export function padRelease(ep: PadEndpoint, timeoutMs = 3_000): Promise<PadExchange> {
  return padRequest(ep, { t: "release" }, timeoutMs);
}

export function padStatus(ep: PadEndpoint, timeoutMs = 3_000): Promise<PadExchange> {
  return padRequest(ep, { t: "status" }, timeoutMs);
}

/** The ack line in the `<- {...}` shape pressButton's callers already log. */
export function ackLine(x: PadExchange): string | undefined {
  return x.ack ? JSON.stringify(x.ack) : undefined;
}

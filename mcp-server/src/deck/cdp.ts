/**
 * A minimal Chrome DevTools Protocol client for the Steam Deck's CEF.
 *
 * Steam's client is CEF, and with ~/.steam/steam/.cef-enable-remote-debugging
 * present it listens on 127.0.0.1:8080 on the Deck. Decky Loader needs that same
 * file, so on any machine that can run DPS at all it is normally already there.
 *
 * Only two calls are needed: list the targets over HTTP, then Runtime.evaluate
 * over a WebSocket. Everything else CDP offers is out of scope.
 */
import http from "http";
import { MiniWebSocket } from "./ws.js";

export interface CdpTarget {
  id: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl?: string;
}

export interface CdpVersion {
  browser?: string;
  protocolVersion?: string;
  userAgent?: string;
}

function getJson<T>(url: string, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`GET ${url} returned HTTP ${res.statusCode}`));
        return;
      }
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (body += c));
      res.on("end", () => {
        try {
          resolve(JSON.parse(body) as T);
        } catch (err) {
          reject(new Error(`GET ${url} returned unparseable JSON: ${(err as Error).message}`));
        }
      });
    });
    req.on("timeout", () => {
      req.destroy(new Error(`GET ${url} timed out after ${timeoutMs}ms`));
    });
    req.on("error", reject);
  });
}

export async function listTargets(base: string, timeoutMs = 6000): Promise<CdpTarget[]> {
  return getJson<CdpTarget[]>(`${base}/json/list`, timeoutMs);
}

export async function getVersion(base: string, timeoutMs = 6000): Promise<CdpVersion> {
  const raw = await getJson<Record<string, string>>(`${base}/json/version`, timeoutMs);
  return {
    browser: raw.Browser,
    protocolVersion: raw["Protocol-Version"],
    userAgent: raw["User-Agent"],
  };
}

/**
 * CEF reports its own address in webSocketDebuggerUrl. When we reach it through
 * an SSH forward on a different local port, that address is wrong for us -- so
 * the host:port is rewritten to the one we actually dialled.
 */
export function rewriteWsHost(wsUrl: string, base: string): string {
  const b = new URL(base);
  return wsUrl.replace(/^ws:\/\/[^/]+/, `ws://${b.hostname}:${b.port || "80"}`);
}

export class CdpEvaluateError extends Error {}

/** Run an expression in a target and return its value, serialized by value. */
export async function evaluate<T>(
  wsUrl: string,
  expression: string,
  timeoutMs = 10_000,
): Promise<T> {
  const ws = await MiniWebSocket.connect(wsUrl, { timeoutMs });
  try {
    return await new Promise<T>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new CdpEvaluateError(`Runtime.evaluate timed out after ${timeoutMs}ms`)),
        timeoutMs,
      );

      ws.onClose((reason) => {
        clearTimeout(timer);
        reject(new CdpEvaluateError(`connection closed before a reply: ${reason}`));
      });

      ws.onMessage((text) => {
        let msg: {
          id?: number;
          result?: {
            result?: { value?: T };
            exceptionDetails?: { text?: string; exception?: { description?: string } };
          };
          error?: { message?: string };
        };
        try {
          msg = JSON.parse(text);
        } catch {
          return; // not ours; CDP also emits events we did not subscribe to
        }
        if (msg.id !== 1) return;

        clearTimeout(timer);
        if (msg.error) {
          reject(new CdpEvaluateError(`CDP error: ${msg.error.message ?? "unknown"}`));
          return;
        }
        const details = msg.result?.exceptionDetails;
        if (details) {
          const why = details.exception?.description ?? details.text ?? "unknown";
          reject(new CdpEvaluateError(`expression threw in the page: ${why}`));
          return;
        }
        resolve(msg.result?.result?.value as T);
      });

      ws.send(
        JSON.stringify({
          id: 1,
          method: "Runtime.evaluate",
          params: { expression, returnByValue: true, awaitPromise: true },
        }),
      );
    });
  } finally {
    ws.close();
  }
}

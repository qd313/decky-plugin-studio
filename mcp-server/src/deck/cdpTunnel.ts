/**
 * An ephemeral SSH forward to the Deck's CEF debugger.
 *
 * CEF binds 127.0.0.1:8080 on the Deck, so it is not reachable from here without
 * a forward leg. The repo's existing tunnel (reverse-tunnel-deck-ingest) runs the
 * other direction, Deck -> PC, for debug ingest.
 *
 * This opens a forward for the duration of one call and closes it again, rather
 * than asking a caller to have started something first. A tool that silently
 * depends on a tunnel someone else remembered to open is the same class of
 * failure as a tool that reports success for work that did not happen: it works
 * on the machine where it was written and nowhere else.
 *
 * A caller that already has a tunnel can pass its own cdpUrl and skip this.
 */
import { spawn, ChildProcess } from "child_process";
import net from "net";
import { readDeckEnv } from "../config.js";
import { getVersion } from "./cdp.js";

export interface CdpTunnel {
  base: string;
  close: () => void;
}

export class DeckNotConfiguredError extends Error {}

/** An OS-assigned free port, so concurrent runs cannot collide. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (addr && typeof addr === "object") {
        const port = addr.port;
        srv.close(() => resolve(port));
      } else {
        srv.close(() => reject(new Error("could not obtain a local port")));
      }
    });
  });
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function openCdpTunnel(readyTimeoutMs = 12_000): Promise<CdpTunnel> {
  const env = readDeckEnv();
  const host = env.DECK_IP;
  const user = env.DECK_USER ?? "deck";

  if (!host) {
    throw new DeckNotConfiguredError(
      "No DECK_IP configured. Run deck_configure with DECK_IP (and DECK_USER if not 'deck'), " +
        "or pass an explicit cdpUrl if you already have a tunnel open.",
    );
  }

  const port = await freePort();
  const args = [
    "-N",
    "-o",
    "BatchMode=yes",
    "-o",
    "ExitOnForwardFailure=yes",
    "-o",
    "ConnectTimeout=8",
    "-o",
    "ServerAliveInterval=30",
    "-L",
    `${port}:127.0.0.1:8080`,
    `${user}@${host}`,
  ];

  const child: ChildProcess = spawn("ssh", args, { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (d: string) => (stderr += d));

  let exited = false;
  child.on("exit", () => (exited = true));

  const base = `http://127.0.0.1:${port}`;
  const close = (): void => {
    if (!child.killed) child.kill();
  };

  // Poll until CEF answers through the forward. ssh reports the socket as open
  // before the far end is usable, so a fixed sleep would be a guess.
  const deadline = Date.now() + readyTimeoutMs;
  for (;;) {
    if (exited) {
      close();
      throw new Error(
        `ssh forward to ${user}@${host} exited before the tunnel came up. ` +
          `${stderr.trim() || "No stderr. Check that key-based SSH to the Deck works."}`,
      );
    }
    try {
      await getVersion(base, 2000);
      return { base, close };
    } catch {
      if (Date.now() > deadline) {
        close();
        throw new Error(
          `Tunnel to ${user}@${host} opened but Steam's CEF did not answer on 127.0.0.1:8080 ` +
            `within ${readyTimeoutMs}ms. Confirm ~/.steam/steam/.cef-enable-remote-debugging ` +
            "exists on the Deck and that Steam has been restarted since it was created.",
        );
      }
      await sleep(300);
    }
  }
}

/** Open a tunnel, run one operation, always close it. */
export async function withCdpTunnel<T>(fn: (base: string) => Promise<T>): Promise<T> {
  const tunnel = await openCdpTunnel();
  try {
    return await fn(tunnel.base);
  } finally {
    tunnel.close();
  }
}

/**
 * A shared SSH forward to the Deck's CEF debugger, kept alive for the life of
 * the server process.
 *
 * CEF binds 127.0.0.1:8080 on the Deck, so it is not reachable from here without
 * a forward leg. The repo's existing tunnel (reverse-tunnel-deck-ingest) runs the
 * other direction, Deck -> PC, for debug ingest.
 *
 * THIS USED TO OPEN A FRESH TUNNEL PER CALL. Every deck_readPage, deck_readFocus,
 * deck_walkTo, deck_runSequence and deck_sweep call spent a full SSH handshake
 * plus a 300ms-step readiness poll before it could even start the ~150ms CDP
 * round trip it actually wanted -- on this network, close to a second of setup
 * for a fraction of a second of work. Now that a single button press is down to
 * roughly 0.4s, that per-call tunnel was the largest remaining cost on any
 * read-heavy run.
 *
 * So: one tunnel, opened lazily on first use, handed out to every caller of
 * openCdpTunnel()/withCdpTunnel() until something invalidates it. The `close()`
 * every caller already calls in its own `finally` is now a no-op -- the tunnel
 * outlives any single call on purpose. What actually tears it down:
 *
 *   - SSH itself exiting (network drop, Deck asleep, ExitOnForwardFailure
 *     firing). Detected via the child's own `exit` event and rebuilt lazily on
 *     the next acquire -- never eagerly, never by polling CDP through it, which
 *     would just reintroduce the per-call round trip this exists to remove.
 *     ServerAliveInterval/ServerAliveCountMax are tuned down from ssh's
 *     defaults (10s / 3, was the ad-hoc default of 30s / 3) specifically
 *     because this tunnel is now long-lived: a dead link is worth noticing in
 *     under 30s rather than up to 90s, since nothing else will notice it for
 *     you between calls.
 *   - The configured Deck IP (or user) changing. Compared by key
 *     (`user@host`) on every acquire; a mismatch tears down the old forward
 *     before opening a new one, so a stale tunnel to yesterday's Deck is never
 *     handed to today's call.
 *   - killAllTunnels() (killswitch.ts), via the same cross-process tunnel
 *     registry every SSH forward in this codebase already registers with --
 *     deck_stopAutomation and the other stop sources reach this exactly the
 *     way they reach the ingest tunnel in tools/deck.ts.
 *   - closeSharedCdpTunnel(), called from index.ts on normal server shutdown
 *     (stdin closing, SIGINT) so a stopped server never leaves an orphaned ssh
 *     process behind -- and available to tests for the same reason.
 *
 * Two calls racing to create the first tunnel share one creation: the pending
 * promise is memoized by key before either await, so a second caller that
 * arrives before the first has finished connecting is handed the same promise
 * rather than starting a second ssh process.
 *
 * The `spawn` and `freePort` calls go through the mutable `proc` object rather
 * than being called directly, for the same reason deployHelpers.ts does this
 * for execSync: child_process's exports are non-configurable, so `mock.method`
 * cannot replace them, and tests need a real seam to fake ssh without a
 * network. See cdpTunnel.test.ts.
 *
 * A caller that already has a tunnel of its own can still pass an explicit
 * cdpUrl and skip this module entirely -- that path is unchanged.
 */
import { spawn as spawnProcess, ChildProcess } from "child_process";
import net from "net";
import { readDeckEnv } from "../config.js";
import { getVersion } from "./cdp.js";
import { registerTunnel, unregisterTunnel } from "./killswitch.js";

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

/**
 * Seam over the process-spawning layer. Production code calls through this
 * object instead of `spawn`/`freePort` directly; tests fake ssh by replacing
 * `proc.spawn` (and, so the readiness poll has something real to reach without
 * a network, `proc.freePort`) for the duration of a case.
 */
export const proc = {
  spawn: spawnProcess,
  freePort,
};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** The live shared tunnel, if one is open and has not been invalidated. */
interface SharedTunnel {
  /** `user@host` this tunnel forwards to -- the cache key. */
  key: string;
  host: string;
  user: string;
  port: number;
  base: string;
  child: ChildProcess;
  /** This tunnel's id in the killswitch's cross-process registry. */
  tunnelId: string;
  /** Set once the ssh child's own `exit` event fires. */
  exited: boolean;
}

let shared: SharedTunnel | null = null;
/** A creation in flight, so concurrent first-callers share one ssh process. */
let pending: { key: string; promise: Promise<SharedTunnel> } | null = null;

/**
 * Tear down one shared tunnel: unregister it from the killswitch, kill the
 * ssh child if it is not already gone, and clear `shared` if this is still
 * the tunnel currently installed there (it may already have been replaced,
 * e.g. by a newer creation that landed while this one was being torn down).
 */
function teardown(state: SharedTunnel): void {
  if (shared === state) shared = null;
  unregisterTunnel(state.tunnelId);
  if (!state.child.killed) state.child.kill();
}

/**
 * Release the process-wide shared CDP tunnel, if one is open. Idempotent, and
 * safe to call whether or not a tunnel currently exists.
 *
 * Called from index.ts on normal server shutdown, so a closed MCP connection
 * never leaves an ssh process running behind it. Also the reset hook
 * cdpTunnel.test.ts uses between cases.
 */
export function closeSharedCdpTunnel(): void {
  if (shared) teardown(shared);
  pending = null;
}

/** Open one ssh forward and poll it until CEF answers, or give up. */
async function createTunnel(host: string, user: string, key: string, readyTimeoutMs: number): Promise<SharedTunnel> {
  const port = await proc.freePort();
  const args = [
    "-N",
    "-o",
    "BatchMode=yes",
    "-o",
    "ExitOnForwardFailure=yes",
    "-o",
    "ConnectTimeout=8",
    // Tuned down from ssh's ordinary default (30s/3, ~90s worst case) because
    // this tunnel is now long-lived rather than opened fresh per call: a dead
    // link is worth noticing well inside a minute, since nothing else probes
    // this connection between calls the way the old per-call readiness poll
    // effectively did.
    "-o",
    "ServerAliveInterval=10",
    "-o",
    "ServerAliveCountMax=3",
    "-L",
    `${port}:127.0.0.1:8080`,
    `${user}@${host}`,
  ];

  const child = proc.spawn("ssh", args, { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (d: string) => (stderr += d));

  const base = `http://127.0.0.1:${port}`;
  const detail = `${user}@${host} -> 127.0.0.1:${port}`;

  const state: SharedTunnel = { key, host, user, port, base, child, tunnelId: "", exited: false };
  child.on("exit", () => {
    state.exited = true;
  });

  // Registered before the readiness poll, and reachable for this tunnel's
  // whole life afterwards -- not just during the poll, as when every tunnel
  // lived for one call. The killswitch closer only kills the child and clears
  // `shared`; it does not unregister itself, because killAllTunnels() does
  // that right after calling it (killswitch.ts), the same contract the ingest
  // tunnel in tools/deck.ts relies on.
  state.tunnelId = registerTunnel("cdp", child.pid, detail, () => {
    if (shared === state) shared = null;
    if (!child.killed) child.kill();
  });

  const deadline = Date.now() + readyTimeoutMs;
  for (;;) {
    if (state.exited) {
      unregisterTunnel(state.tunnelId);
      if (!child.killed) child.kill();
      throw new Error(
        `ssh forward to ${user}@${host} exited before the tunnel came up. ` +
          `${stderr.trim() || "No stderr. Check that key-based SSH to the Deck works."}`,
      );
    }
    try {
      await getVersion(base, 2000);
      return state;
    } catch {
      if (Date.now() > deadline) {
        unregisterTunnel(state.tunnelId);
        if (!child.killed) child.kill();
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

/**
 * Return the shared tunnel, creating or replacing it as needed.
 *
 * Synchronous up to the first `await` inside createTunnel(), which is what
 * makes the concurrent-callers case work: two calls that both find no usable
 * tunnel and no creation in flight run this prefix back to back with no
 * interleaving, so the first one's `pending` assignment is always visible to
 * the second before it decides whether to start its own.
 */
async function acquireSharedTunnel(readyTimeoutMs: number): Promise<SharedTunnel> {
  const env = readDeckEnv();
  const host = env.DECK_IP;
  const user = env.DECK_USER ?? "deck";

  if (!host) {
    throw new DeckNotConfiguredError(
      "No DECK_IP configured. Run deck_configure with DECK_IP (and DECK_USER if not 'deck'), " +
        "or pass an explicit cdpUrl if you already have a tunnel open.",
    );
  }
  const key = `${user}@${host}`;

  if (shared) {
    if (shared.key === key && !shared.exited) {
      return shared;
    }
    // Stale: either ssh itself has exited (network drop, Deck asleep, timed
    // out) or the configured Deck changed out from under us. Either way this
    // tunnel must never be handed out again -- tear it down before starting a
    // replacement, so a dead or wrong-host forward is never reused and never
    // lingers as an orphaned ssh process.
    teardown(shared);
  }

  if (pending && pending.key === key) {
    return pending.promise;
  }

  const promise = createTunnel(host, user, key, readyTimeoutMs)
    .then((state) => {
      if (pending?.key === key) pending = null;
      shared = state;
      return state;
    })
    .catch((err) => {
      if (pending?.key === key) pending = null;
      throw err;
    });
  pending = { key, promise };
  return promise;
}

/**
 * Get the shared tunnel, opening it if this is the first call (or the last
 * one died, or the configured Deck changed). `close()` on the result is
 * intentionally a no-op: every existing caller still calls it in its own
 * `finally`, and that is fine -- it simply no longer tears anything down. The
 * tunnel is released instead by closeSharedCdpTunnel(), the killswitch, or
 * being superseded by a fresher one.
 */
export async function openCdpTunnel(readyTimeoutMs = 12_000): Promise<CdpTunnel> {
  const state = await acquireSharedTunnel(readyTimeoutMs);
  return {
    base: state.base,
    close: () => {
      /* no-op: see module doc comment */
    },
  };
}

/** Get the shared tunnel, run one operation. Does not close it afterwards. */
export async function withCdpTunnel<T>(fn: (base: string) => Promise<T>): Promise<T> {
  const tunnel = await openCdpTunnel();
  try {
    return await fn(tunnel.base);
  } finally {
    tunnel.close();
  }
}

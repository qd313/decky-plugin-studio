#!/usr/bin/env node
/**
 * The killswitch, from a terminal.
 *
 *   node scripts/stop-deck-automation.mjs            stop everything
 *   node scripts/stop-deck-automation.mjs --status   is it armed?
 *   node scripts/stop-deck-automation.mjs --arm      re-arm (a human, at a keyboard)
 *
 * The status bar button covers the case where someone is looking at the editor.
 * This covers the one where they are not: an agent driving the Deck from a
 * terminal, a headless run, a VS Code window that is busy or wedged. The person
 * who needs to stop the rig should not first have to find the right window.
 *
 * THE LATCH IS WRITTEN HERE, WITH NOTHING BUT `fs`. No imports from the built
 * server, no dependency on anything having been compiled. That is deliberate:
 * this file has to work in a checkout where `pnpm run build:mcp` was never run,
 * or has just failed, or is mid-rebuild. Writing the file is the whole of the
 * guarantee -- every press in every Studio process checks it immediately before
 * it spawns -- so the part that cannot fail is the part that matters.
 *
 * The release and the tunnel teardown DO need the built server, because they
 * are real logic that should exist in exactly one place. If the build is not
 * there they are skipped and the output says so, rather than printing a tick
 * over work that did not happen.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const CONFIG_DIR = path.join(os.homedir(), ".config", "decky-plugin-studio");
const LATCH = path.join(CONFIG_DIR, "automation-stop.json");
const BUILT = path.join(
  path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")),
  "..",
  "mcp-server",
  "dist",
  "deck",
  "killswitch.js",
);

const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);
const reason = (() => {
  const i = args.findIndex((a) => a === "--reason");
  return i >= 0 ? args[i + 1] : undefined;
})();

function readLatch() {
  try {
    if (!fs.existsSync(LATCH)) return null;
    return JSON.parse(fs.readFileSync(LATCH, "utf8"));
  } catch {
    // Present but unreadable still counts as stopped, as everywhere else.
    return fs.existsSync(LATCH) ? { at: "unknown time", by: "unknown" } : null;
  }
}

/** The built server, or null. Never fatal -- the latch does not need it. */
async function loadKillswitch() {
  if (!fs.existsSync(BUILT)) return null;
  try {
    return await import(pathToFileURL(BUILT).href);
  } catch {
    return null;
  }
}

if (has("--status")) {
  const latch = readLatch();
  if (latch) {
    console.log(`STOPPED since ${latch.at} (${latch.by})${latch.reason ? `: ${latch.reason}` : ""}`);
    console.log(`latch: ${LATCH}`);
    process.exit(1); // non-zero so a shell can branch on it
  }
  console.log("armed -- the rig can press");
  process.exit(0);
}

if (has("--arm")) {
  const latch = readLatch();
  if (!latch) {
    console.log("already armed; nothing to clear");
    process.exit(0);
  }
  console.log(`clearing a stop set at ${latch.at} by ${latch.by}`);
  if (latch.reason) console.log(`  reason given: ${latch.reason}`);
  fs.rmSync(LATCH, { force: true });
  console.log("re-armed -- Studio processes may press buttons again");
  process.exit(0);
}

// ---- stop ------------------------------------------------------------------

const already = readLatch();
const record = already ?? {
  at: new Date().toISOString(),
  by: "cli",
  reason: reason ?? "stopped from the terminal",
  pid: process.pid,
  host: os.hostname(),
};

try {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(LATCH, JSON.stringify(record, null, 2), "utf8");
} catch (err) {
  console.error("");
  console.error("*** COULD NOT WRITE THE LATCH -- AUTOMATION IS NOT STOPPED ***");
  console.error(`    ${LATCH}: ${err.message}`);
  console.error("    Unplug the bridge board's USB side from the Deck.");
  process.exit(2);
}

console.log("automation LATCHED OFF -- no Studio process can press a button");
if (already) console.log(`  (it was already stopped since ${already.at}, by ${already.by})`);

const ks = await loadKillswitch();
if (!ks) {
  console.log("");
  console.log("The built server was not found, so these steps were SKIPPED:");
  console.log("  - telling the board to release whatever it is holding");
  console.log("  - tearing down the SSH tunnels");
  console.log("The board goes neutral by itself 750 ms after the link falls silent,");
  console.log("which the latch above guarantees. Run `pnpm run build:mcp` for the rest.");
  console.log(`latch: ${LATCH}`);
  process.exit(0);
}

const release = await ks.releaseAllButtons();
console.log(
  release.ok
    ? "board released"
    : `board release NOT confirmed: ${release.detail}`,
);

const tunnels = ks.killAllTunnels();
console.log(
  tunnels.closed || tunnels.failed
    ? `tunnels: ${tunnels.byKind.cdp} cdp + ${tunnels.byKind.ingest} ingest closed` +
      (tunnels.failed ? `, ${tunnels.failed} could NOT be closed` : "")
    : "no live tunnels were registered",
);
for (const detail of tunnels.details) console.log(`  ${detail}`);

console.log("");
console.log("Re-arm with --arm, the status bar item, or 'Decky: Arm Deck Automation'.");
console.log(`latch: ${LATCH}`);

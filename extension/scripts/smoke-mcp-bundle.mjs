#!/usr/bin/env node
/**
 * Start the MCP server exactly as the installed extension does, and require it
 * to answer.
 *
 * The VSIX shipped a server that could not start for its entire life: only
 * `dist/` was bundled, so the first `import "pngjs"` threw ERR_MODULE_NOT_FOUND
 * and the process died before reading a request. Nothing noticed. The extension
 * caught the failure and moved on, the status bar rendered its all-false
 * defaults, and the result read as "your Deck is offline" rather than "Studio
 * is broken".
 *
 * A dependency check would have caught that one omission. Starting the thing
 * catches the class: a missing dep, a wrong module type, a top-level throw, a
 * stale dist. It runs against exactly what ships, which is the only build whose
 * failure a user ever sees.
 *
 * Usage: node smoke-mcp-bundle.mjs <entry.js> <cwd>
 */
import cp from "child_process";

const [entry, cwd] = process.argv.slice(2);
if (!entry || !cwd) {
  console.error("usage: smoke-mcp-bundle.mjs <entry.js> <cwd>");
  process.exit(2);
}

const child = cp.spawn(process.execPath, [entry], {
  cwd,
  env: { ...process.env, DECKY_STUDIO_REPO: cwd },
  stdio: ["pipe", "pipe", "pipe"],
});

let stderr = "";
let answered = false;

const fail = (why) => {
  console.error(`  ${why}`);
  if (stderr.trim()) console.error(stderr.trim().split("\n").map((l) => `  | ${l}`).join("\n"));
  child.kill();
  process.exit(1);
};

child.stderr.on("data", (c) => {
  stderr += c.toString();
});

child.stdout.once("data", () => {
  answered = true;
  child.kill();
  console.log("  bundled MCP server answered initialize");
  process.exit(0);
});

child.on("error", (err) => fail(`could not spawn the bundled MCP server: ${err.message}`));
child.on("exit", (code) => {
  if (!answered) fail(`bundled MCP server exited (code ${code}) before answering`);
});

child.stdin.write(
  JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) + "\n",
);

setTimeout(() => fail("bundled MCP server never answered initialize (20s)"), 20_000);

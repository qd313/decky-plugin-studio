/**
 * Tests for the debug-ingest listener's failure to start.
 *
 * The port is fixed and the extension spawns one MCP server per VS Code
 * window, so a second window always lands on a taken port. Before this was
 * handled, the resulting EADDRINUSE arrived as an unhandled 'error' event on
 * the http.Server and killed the whole process with exit code 1 -- before the
 * MCP handshake, so the window reported only "MCP server exited (code 1)
 * before replying" on a loop. Ingest is optional; the rest of the server is
 * not, and that is what these tests pin.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "http";

import {
  startIngestServer,
  stopIngestServer,
  isIngestRunning,
  getIngestPort,
} from "./server.js";

/** Hold a port the way another MCP server instance would. */
function occupy(port: number): Promise<http.Server> {
  return new Promise((resolve, reject) => {
    const squatter = http.createServer(() => {});
    squatter.once("error", reject);
    squatter.listen(port, "127.0.0.1", () => resolve(squatter));
  });
}

/** Let the failed listen() dispatch its 'error' event. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 50));
}

test("a taken port disables ingest instead of killing the process", async () => {
  const port = 7791;
  const squatter = await occupy(port);
  try {
    startIngestServer(port);
    await settle();
    assert.equal(
      isIngestRunning(),
      false,
      "ingest should report itself off after a failed listen",
    );
  } finally {
    stopIngestServer();
    squatter.close();
  }
});

test("a free port starts ingest and records the port", async () => {
  const port = 7792;
  try {
    startIngestServer(port);
    await settle();
    assert.equal(isIngestRunning(), true);
    assert.equal(getIngestPort(), port);
  } finally {
    stopIngestServer();
  }
});

test("a failed start does not block a later start on a free port", async () => {
  const taken = 7793;
  const squatter = await occupy(taken);
  try {
    startIngestServer(taken);
    await settle();
    assert.equal(isIngestRunning(), false);

    // The singleton guard is `if (server) return`, so a failed start must
    // leave `server` null or the retry is silently a no-op.
    startIngestServer(7794);
    await settle();
    assert.equal(isIngestRunning(), true);
    assert.equal(getIngestPort(), 7794);
  } finally {
    stopIngestServer();
    squatter.close();
  }
});

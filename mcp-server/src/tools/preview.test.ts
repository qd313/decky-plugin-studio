/**
 * Tests for preview_start's honesty.
 *
 * previewStart() used to set `running: true` and return unconditionally --
 * a stale URL left over from a closed preview panel, or one that had never
 * started, was reported as running with nobody ever having asked it a
 * question. Same defect class as bridgeReady/steam-routed on the Deck side,
 * one line on the preview side (see docs/planning/09-parallel-feature-session.md,
 * lane L6).
 *
 * No mocking of `fetch` here: a real local HTTP server (for the "it answers"
 * case) and a real, guaranteed-unreachable port (for the "it does not" case)
 * are cheaper to trust than a stub of the fetch layer.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import type { AddressInfo } from "node:net";

import { previewStart } from "./preview.js";
import { getPreviewStatePath, writePreviewState, type PreviewState } from "../config.js";

/**
 * previewStart reads `~/.decky-plugin-studio/preview-state.json` -- a
 * machine-wide path, not scoped to this test run. Save whatever is there
 * (if anything), point it at a known URL for the duration of one case, and
 * restore exactly what was there afterward, so this suite never corrupts a
 * developer's real preview state.
 */
async function withPreviewState<T>(state: PreviewState, fn: () => Promise<T>): Promise<T> {
  const statePath = getPreviewStatePath();
  const had = fs.existsSync(statePath);
  const prior = had ? fs.readFileSync(statePath, "utf8") : null;
  writePreviewState(state);
  try {
    return await fn();
  } finally {
    if (prior !== null) fs.writeFileSync(statePath, prior, "utf8");
    else if (fs.existsSync(statePath)) fs.rmSync(statePath);
  }
}

test("previewStart reports running:false, with a reason, when nothing answers at the preview URL", () =>
  withPreviewState({ url: "http://127.0.0.1:1" }, async () => {
    const r = await previewStart();
    assert.equal(r.running, false, "a dead URL must not be reported as a running preview");
    assert.equal(r.url, "http://127.0.0.1:1");
    assert.match(r.reason ?? "", /Nothing answered/);
    assert.equal(r.rpcAllowlist, undefined, "nothing was synced -- there is no preview to sync against");
  }));

test("previewStart reports running:true only once the configured URL actually answers", async () => {
  const server = http.createServer((_req, res) => res.end("ok"));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${port}`;

  try {
    await withPreviewState({ url }, async () => {
      const r = await previewStart();
      assert.equal(r.running, true);
      assert.equal(r.url, url);
      assert.equal(r.reason, undefined);
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

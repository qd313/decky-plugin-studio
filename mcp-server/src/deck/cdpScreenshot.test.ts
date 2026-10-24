/*
 * deck_captureScreenshot on a Windows stand-in: Page.captureScreenshot over CDP,
 * a PowerShell window grab when that fails, and the SteamOS path left alone.
 * The window grab itself cannot run on a headless runner; it is stubbed here
 * and is device-unverified.
 */
process.env.DPS_NO_BRIDGE ??= "1";

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ws = fs.mkdtempSync(path.join(os.tmpdir(), "dps-shot-"));
process.env.DECKY_STUDIO_WORKSPACE = ws;

import { startFakeCdp } from "./__testutil__/fakeCdp.js";
import { captureStandinWindows } from "./cdpScreenshot.js";
import { normalizeMachine, runWithMachine } from "../machines.js";
import { buildToolCallContent } from "../toolContent.js";
import * as deck from "../tools/deck.js";

// A real 1x1 PNG, so the bytes are checkable.
const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const PNG = Buffer.from(PNG_B64, "base64");

const portOf = (base: string): number => Number(new URL(base).port);

test("windows stand-in: the tool returns the Big Picture PNG as an image block, method cdp", async () => {
  const fake = await startFakeCdp(["SharedJSContext", "Steam Big Picture Mode", "QuickAccess_uid2"], () => null, {
    screenshot: PNG_B64,
  });
  try {
    const win = normalizeMachine("win", {
      kind: "standin",
      os: "windows",
      local: true,
      press: "vigem",
      cdpPort: portOf(fake.base),
    });
    const result = (await runWithMachine(win, () => deck.captureScreenshot("auto"))) as unknown as Record<string, unknown>;
    assert.equal(result.method, "cdp");
    assert.equal(result.quickAccessPagePresent, true);
    assert.deepEqual(fs.readFileSync(result.path as string), PNG);

    const blocks = buildToolCallContent(result);
    const img = blocks.find((b) => b.type === "image") as { data: string; mimeType: string } | undefined;
    assert.ok(img, "expected an image content block");
    assert.equal(img!.mimeType, "image/png");
    assert.equal(img!.data, PNG_B64);
  } finally {
    await fake.close();
  }
});

test("when CDP refuses the command the window grab is tried and its method is reported", async () => {
  const fake = await startFakeCdp(["Steam Big Picture Mode"], () => null, { screenshot: { __error: "no paint" } });
  const out = path.join(ws, "grab-ok.png");
  let grabbed = 0;
  try {
    const shot = await captureStandinWindows({
      outPath: out,
      cdpUrl: fake.base,
      grabWindow: (p) => {
        grabbed++;
        fs.writeFileSync(p, PNG);
      },
    });
    assert.equal(grabbed, 1);
    assert.equal(shot.method, "window-grab");
  } finally {
    await fake.close();
  }
});

test("when both attempts fail the error names both", async () => {
  const fake = await startFakeCdp(["Steam Big Picture Mode"], () => null, { screenshot: { __error: "no paint" } });
  try {
    await assert.rejects(
      captureStandinWindows({
        outPath: path.join(ws, "never.png"),
        cdpUrl: fake.base,
        grabWindow: () => {
          throw new Error("window minimised");
        },
      }),
      (err: Error) => /CDP Page\.captureScreenshot: .*no paint/.test(err.message) && /window grab: window minimised/.test(err.message),
    );
  } finally {
    await fake.close();
  }
});

test("a steamos machine does not take the CDP path", async () => {
  const fake = await startFakeCdp(["Steam Big Picture Mode"], () => null, { screenshot: PNG_B64 });
  try {
    const sos = normalizeMachine("sos", { kind: "standin", os: "bazzite", local: false, cdpPort: portOf(fake.base) });
    await assert.rejects(runWithMachine(sos, () => deck.captureScreenshot("auto")), /DECK_IP not configured/);
    assert.equal(fake.lists(), 0, "the CDP endpoint must not be contacted for a non-Windows machine");
  } finally {
    await fake.close();
  }
});

test("deck_record still refuses on Windows", async () => {
  const win = normalizeMachine("win", { kind: "standin", os: "windows", local: true, press: "vigem" });
  await assert.rejects(runWithMachine(win, () => deck.recordDeck("5", "auto")), /deck_record is not available/);
});

/*
 * Part 1 of the "MCP tools can only ever say a word, never show a picture"
 * fix. tools/call previously returned exactly one text block no matter what a
 * tool produced, so deck_captureScreenshot's `{ path, bytes, mode, method }`
 * was a filename no MCP client but a co-located file-reading agent could ever
 * open. These tests exercise the dispatch-seam mechanism in toolContent.ts
 * directly (withImage / buildImageBlock / buildToolCallContent /
 * buildToolErrorContent) rather than index.ts's own tools/call case: index.ts
 * starts an ingest server and a stdin listener as soon as it is imported (see
 * ingest/server.ts), so it cannot be imported in a unit test without side
 * effects -- toolRegistry.test.ts hits the same wall and works around it by
 * parsing index.ts's source instead. The last test below does the same, to
 * prove the mechanism defined here is actually wired into that case and not
 * just defined and unused.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { PNG } from "pngjs";

import {
  withImage,
  buildImageBlock,
  buildToolCallContent,
  buildToolErrorContent,
  MAX_IMAGE_BASE64_BYTES,
} from "./toolContent.js";

const here = path.dirname(fileURLToPath(import.meta.url));

function makePng(width: number, height: number, noisy: boolean): Buffer {
  const png = new PNG({ width, height });
  for (let i = 0; i < png.data.length; i += 4) {
    if (noisy) {
      png.data[i] = Math.floor(Math.random() * 256);
      png.data[i + 1] = Math.floor(Math.random() * 256);
      png.data[i + 2] = Math.floor(Math.random() * 256);
    } else {
      png.data[i] = 10;
      png.data[i + 1] = 20;
      png.data[i + 2] = 30;
    }
    png.data[i + 3] = 255;
  }
  return PNG.sync.write(png);
}

// ---------------------------------------------------------------------------
// withImage(): the attachment must be invisible to everything except the
// dispatch seam.
// ---------------------------------------------------------------------------

test("withImage's attachment is invisible to JSON.stringify, Object.keys, spread, and deepStrictEqual", () => {
  const plain = { path: "/tmp/x.png", bytes: 123, mode: "auto", method: "grim" };
  const attached = withImage({ ...plain }, { path: "/tmp/x.png" });

  // Every caller that isn't tools/call must see exactly the plain shape --
  // the extension's own dialect, and any test asserting a tool's return value.
  assert.deepStrictEqual(attached, plain);
  assert.deepEqual(Object.keys(attached), Object.keys(plain));
  assert.equal(JSON.stringify(attached), JSON.stringify(plain));
  assert.deepEqual({ ...attached }, plain);
});

// ---------------------------------------------------------------------------
// buildToolCallContent(): a capture result produces both a text and an image
// block, and the base64 decodes to the exact bytes on disk.
// ---------------------------------------------------------------------------

test("buildToolCallContent attaches a small image alongside the text block, decoding back to the exact bytes on disk", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "decky-toolcontent-"));
  const file = path.join(tmp, "shot.png");
  const bytes = makePng(64, 40, false);
  fs.writeFileSync(file, bytes);
  try {
    const result = withImage(
      { path: file, bytes: bytes.length, mode: "auto", method: "grim" },
      { path: file }
    );
    const content = buildToolCallContent(result);

    assert.equal(content.length, 2, "expected one text block and one image block");
    assert.equal(content[0].type, "text");
    assert.equal(content[1].type, "image");

    const img = content[1] as { type: "image"; data: string; mimeType: string };
    assert.equal(img.mimeType, "image/png");
    assert.deepEqual(Buffer.from(img.data, "base64"), fs.readFileSync(file));

    const payload = JSON.parse((content[0] as { type: "text"; text: string }).text);
    assert.equal(payload.path, file);
    assert.equal(payload.bytes, bytes.length);
    assert.equal(payload.mode, "auto");
    assert.equal(payload.method, "grim");
    assert.equal(payload.image.attached, true);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("a tool result with no image attachment still produces exactly the one text block it always has", () => {
  const content = buildToolCallContent({ ok: true, tunnelRunning: false });
  assert.equal(content.length, 1);
  assert.equal(content[0].type, "text");
  assert.deepEqual(JSON.parse((content[0] as { type: "text"; text: string }).text), {
    ok: true,
    tunnelRunning: false,
  });
});

test("buildToolCallContent states in the text block when the image could not be read", () => {
  const missing = path.join(os.tmpdir(), "decky-studio-does-not-exist-" + Date.now() + ".png");
  const result = withImage({ path: missing }, { path: missing });
  const content = buildToolCallContent(result);

  // No malformed/empty image block -- dropping means dropping, not attaching
  // a broken one.
  assert.equal(content.length, 1);
  assert.equal(content[0].type, "text");

  const payload = JSON.parse((content[0] as { type: "text"; text: string }).text);
  assert.equal(payload.image.attached, false);
  assert.match(payload.image.note, /omitted/i);
});

// ---------------------------------------------------------------------------
// buildImageBlock(): size cap and downscale behaviour.
// ---------------------------------------------------------------------------

test("a typical flat-colour 1280x800 plugin screenshot fits under the default cap without downscaling", () => {
  // Decky's own UI is mostly flat panels and text -- the case the default cap
  // is sized for.
  const bytes = makePng(1280, 800, false);
  const outcome = buildImageBlock({ data: bytes });
  assert.equal(outcome.attached, true);
  assert.equal(outcome.downscaled, undefined);
  assert.ok(outcome.block);
});

test("an oversized image is downscaled rather than dropped", () => {
  // Random noise is close to incompressible, so this reliably exceeds a cap
  // set below its own size.
  const bytes = makePng(400, 400, true);
  const originalBase64Len = bytes.toString("base64").length;
  const cap = Math.floor(originalBase64Len / 2);

  const outcome = buildImageBlock({ data: bytes }, { maxBase64Bytes: cap, minDimension: 50 });

  assert.equal(outcome.attached, true);
  assert.equal(outcome.downscaled, true);
  assert.ok(outcome.block, "expected an image block, not a drop");
  assert.ok(outcome.block!.data.length <= cap, `${outcome.block!.data.length} > cap ${cap}`);
  assert.match(outcome.note, /downscaled/i);

  const resized = PNG.sync.read(Buffer.from(outcome.block!.data, "base64"));
  const original = PNG.sync.read(bytes);
  assert.ok(resized.width < original.width && resized.height < original.height);
});

test("an image that cannot be downscaled under the cap is dropped, and the note says why", () => {
  const bytes = makePng(60, 60, true);
  // A cap no real PNG can meet, even at a 1px floor -- forces the "give up"
  // branch deterministically instead of depending on how noise compresses.
  const outcome = buildImageBlock({ data: bytes }, { maxBase64Bytes: 8, minDimension: 1 });

  assert.equal(outcome.attached, false);
  assert.equal(outcome.block, undefined);
  assert.match(outcome.note, /omitted/i);
  assert.match(outcome.note, /floor/i);
});

test("MAX_IMAGE_BASE64_BYTES is sized for a real Deck screenshot (~1280x800), not arbitrary", () => {
  // Base64 inflates by ~4/3, so this bounds decoded size to roughly 0.7-1.1 MB
  // -- generous for a compressed plugin-UI PNG, bounded against a
  // photographic worst case.
  assert.ok(MAX_IMAGE_BASE64_BYTES >= 1_000_000);
  assert.ok(MAX_IMAGE_BASE64_BYTES <= 3_000_000);
});

// ---------------------------------------------------------------------------
// buildToolErrorContent(): a capture failure must never smuggle an image
// block past the client, however the error is shaped.
// ---------------------------------------------------------------------------

test("buildToolErrorContent always returns exactly one text block and never an image block", () => {
  const errorShapes: unknown[] = [
    new Error("Screenshot failed (method=unknown, bytes=0). Open QAM + plugin first."),
    "plain string failure",
    { type: "image", data: "not-real-base64", mimeType: "image/png" }, // adversarial shape
    undefined,
  ];
  for (const err of errorShapes) {
    const out = buildToolErrorContent(err);
    assert.equal(out.isError, true);
    assert.equal(out.content.length, 1);
    assert.equal(out.content[0].type, "text");
    assert.ok(!out.content.some((b) => (b as { type: string }).type === "image"));
  }
});

// ---------------------------------------------------------------------------
// Wiring: prove index.ts's tools/call case actually calls these, not just
// that they exist. Source-parsed for the same reason toolRegistry.test.ts is
// (see file header).
// ---------------------------------------------------------------------------

test("index.ts's tools/call case is wired to buildToolCallContent and buildToolErrorContent", () => {
  const indexSource = fs.readFileSync(path.join(here, "index.ts"), "utf8");
  const start = indexSource.indexOf('case "tools/call":');
  assert.ok(start >= 0, "could not find the tools/call case in index.ts");
  const body = indexSource.slice(start, start + 1500);
  assert.match(body, /buildToolCallContent\(result\)/);
  assert.match(body, /buildToolErrorContent\(err\)/);
});

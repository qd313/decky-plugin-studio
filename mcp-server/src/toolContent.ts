import fs from "fs";
import { PNG } from "pngjs";

/**
 * The dispatch-seam mechanism for attaching pictures to tool results.
 *
 * `tools/call` (in index.ts) can only ever return one MCP content array per
 * call, and every plugin tool's return value is also read directly by the
 * extension's own JSON-RPC dialect (`handle()`) and by tests that call a tool
 * function straight, without going through MCP at all. Bolting an `image`
 * field onto every capture tool's return shape would change what all of those
 * callers see for a value nobody but `tools/call` needs.
 *
 * Instead a tool that has a picture calls `withImage(result, { path })` on the
 * plain object it was already returning. That stores the attachment behind a
 * non-enumerable symbol key, which `JSON.stringify`, `Object.keys`, spreads,
 * and `assert.deepStrictEqual` (which only compares enumerable own
 * properties) all skip -- so the object still looks exactly like `{ path,
 * bytes, mode, method }` everywhere except the one place that knows to look:
 * `buildToolCallContent()` below, called from the `tools/call` case.
 *
 * The next tool that returns a picture just calls `withImage()` on its result
 * and is done -- no changes to index.ts, no new special case.
 */
export interface ImageAttachment {
  /** Absolute path to a PNG already written to disk. */
  path?: string;
  /** PNG bytes already in memory (skips the disk read `path` would need). */
  data?: Buffer;
}

const IMAGE_ATTACHMENT = Symbol("decky-studio.imageAttachment");

export function withImage<T extends object>(result: T, attachment: ImageAttachment): T {
  Object.defineProperty(result, IMAGE_ATTACHMENT, {
    value: attachment,
    enumerable: false,
    configurable: true,
  });
  return result;
}

function takeImage(result: unknown): ImageAttachment | undefined {
  if (result && typeof result === "object" && IMAGE_ATTACHMENT in (result as object)) {
    return (result as Record<symbol, ImageAttachment>)[IMAGE_ATTACHMENT];
  }
  return undefined;
}

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

/**
 * Cap on the *base64* payload, not the raw file.
 *
 * A Deck screenshot is roughly 1280x800. Decky's own plugin UI is mostly flat
 * panels and text, which PNG compresses well -- typically a few hundred KB.
 * A busy game frame behind the overlay compresses far worse (PNG has no
 * photographic transform) and can land past a megabyte. 1.5 MB of base64
 * (~1.1 MB decoded) comfortably covers the plugin-UI case Studio exists for,
 * while still bounding the photographic worst case to something a client
 * can render without choking -- past that we downscale instead of shipping
 * an ever-larger blob.
 */
export const MAX_IMAGE_BASE64_BYTES = 1_500_000;

/** Below this, a downscaled screenshot stops being useful to look at. */
export const MIN_IMAGE_DIMENSION = 240;

/** Shrink 25% per attempt; six attempts reaches ~18% of the original size. */
const MAX_DOWNSCALE_ATTEMPTS = 6;

function base64Size(byteLength: number): number {
  return Math.ceil(byteLength / 3) * 4;
}

/** Nearest-neighbour resample. Good enough for an agent to orient itself;
 * simple enough to have no external dependency beyond pngjs, which the repo
 * already ships. */
function resamplePng(src: PNG, width: number, height: number): Buffer {
  const dst = new PNG({ width, height });
  for (let y = 0; y < height; y++) {
    const sy = Math.min(src.height - 1, Math.floor((y * src.height) / height));
    for (let x = 0; x < width; x++) {
      const sx = Math.min(src.width - 1, Math.floor((x * src.width) / width));
      const s = (sy * src.width + sx) * 4;
      const d = (y * width + x) * 4;
      src.data.copy(dst.data, d, s, s + 4);
    }
  }
  return PNG.sync.write(dst);
}

export interface ImageOutcome {
  attached: boolean;
  /** Present only when `attached` is true. */
  block?: { type: "image"; data: string; mimeType: string };
  downscaled?: boolean;
  /** Always set -- what an agent reading only the text block should know. */
  note: string;
}

export interface ImageOptions {
  maxBase64Bytes?: number;
  minDimension?: number;
}

/**
 * Read (or take in-memory) the attached image and turn it into an MCP image
 * content block, downscaling if it is over the cap and giving up -- with an
 * explanation, never silently -- only if it is still over the cap once
 * downscaled to `minDimension`.
 */
export function buildImageBlock(attachment: ImageAttachment, opts: ImageOptions = {}): ImageOutcome {
  const maxBase64Bytes = opts.maxBase64Bytes ?? MAX_IMAGE_BASE64_BYTES;
  const minDimension = opts.minDimension ?? MIN_IMAGE_DIMENSION;

  let original: Buffer;
  try {
    original = attachment.data ?? fs.readFileSync(attachment.path!);
  } catch (err) {
    return {
      attached: false,
      note: `Image attachment omitted: could not read ${attachment.path ?? "<in-memory data>"} (${String(err)}).`,
    };
  }

  if (base64Size(original.length) <= maxBase64Bytes) {
    return {
      attached: true,
      block: { type: "image", data: original.toString("base64"), mimeType: "image/png" },
      note: `Image attached (${original.length} bytes).`,
    };
  }

  let src: PNG;
  try {
    src = PNG.sync.read(original);
  } catch (err) {
    return {
      attached: false,
      note:
        `Image attachment omitted: ${original.length}-byte image exceeds the ${maxBase64Bytes}-byte ` +
        `base64 cap and could not be decoded to downscale (${String(err)}).`,
    };
  }

  for (let i = 1; i <= MAX_DOWNSCALE_ATTEMPTS; i++) {
    const scale = Math.pow(0.75, i);
    const width = Math.max(1, Math.round(src.width * scale));
    const height = Math.max(1, Math.round(src.height * scale));
    if (width < minDimension || height < minDimension) break;

    const resized = resamplePng(src, width, height);
    if (base64Size(resized.length) <= maxBase64Bytes) {
      return {
        attached: true,
        downscaled: true,
        block: { type: "image", data: resized.toString("base64"), mimeType: "image/png" },
        note:
          `Image attached (downscaled from ${src.width}x${src.height}/${original.length} bytes to ` +
          `${width}x${height}/${resized.length} bytes to fit the ${maxBase64Bytes}-byte base64 cap).`,
      };
    }
  }

  return {
    attached: false,
    note:
      `Image attachment omitted: ${original.length}-byte image (${src.width}x${src.height}) still ` +
      `exceeds the ${maxBase64Bytes}-byte base64 cap even downscaled to the ${minDimension}px floor. ` +
      `The path in this result still points at the full file on disk.`,
  };
}

/**
 * Build the `tools/call` content array for a tool's return value. Every tool
 * still gets exactly the text block it always had -- the image, when there is
 * one, is additional. If attaching failed or the image was dropped, that is
 * folded into the same JSON as an `image` field so an agent reading only text
 * is never left thinking it received a picture it did not.
 */
export function buildToolCallContent(result: unknown): ContentBlock[] {
  const attachment = takeImage(result);
  if (!attachment) {
    return [{ type: "text", text: JSON.stringify(result ?? null, null, 2) }];
  }

  const outcome = buildImageBlock(attachment);
  const textPayload = {
    ...(result as object),
    image: {
      attached: outcome.attached,
      ...(outcome.downscaled ? { downscaled: true } : {}),
      note: outcome.note,
    },
  };
  const blocks: ContentBlock[] = [{ type: "text", text: JSON.stringify(textPayload, null, 2) }];
  if (outcome.block) blocks.push(outcome.block);
  return blocks;
}

/**
 * The `tools/call` error shape, factored out so it is unit-testable on its
 * own: whatever `err` is, this always produces one text block and never an
 * image block, so a capture failure can never smuggle a malformed image
 * attachment past the client.
 */
export function buildToolErrorContent(err: unknown): { content: ContentBlock[]; isError: true } {
  return { content: [{ type: "text", text: String(err) }], isError: true };
}

/**
 * How it works: reads a tar file's headers one by one, jumping over each
 * entry's data, and says whether the file is a whole, well-formed archive.
 *
 * Why it exists. A settings snapshot taken on 2026-10-12 (before the copy was
 * checked against the Deck's own size and checksum) left a damaged archive on
 * this PC, with a run file that vouched for it (the checksum was of the damaged
 * bytes, so it matched). Every later deck_snapshotSettings first tried to put
 * that old copy back, the Deck's tar answered "Skipping to next header", the
 * call failed and the run file stayed, so all of them failed the same way until
 * someone deleted it by hand (plan 97 Deck block A, 2026-10-22). Checking the
 * archive here, before a byte is sent, turns that into a plain refusal that
 * names the damage and sends nothing to the Deck.
 *
 * Used for: settingsSnapshot.ts, before any restore.
 * Solves: telling a damaged saved copy from a Deck or network problem.
 * Does not: read file contents (only 512-byte headers are read, so a 230 MB
 * archive takes a few milliseconds), unpack anything, or need a tar program on
 * this PC (Windows' own tar.exe exits 0 on a damaged archive, so it cannot be
 * the judge).
 */
import fs from "node:fs";

const BLOCK = 512;

/** Entry types that carry data after their header. Links, directories and devices carry none. */
const DATA_TYPES = new Set(["0", "\u0000", "7", "L", "K", "x", "g", "X", "S"]);
/** Entry types that only describe the next entry; they are not counted as entries. */
const EXTENSION_TYPES = new Set(["x", "g", "L", "K", "X"]);

export type TarCheck =
  | { ok: true; entries: number; bytes: number }
  | { ok: false; entry: number; offsetBytes: number; reason: string };

function fieldText(b: Buffer, from: number, to: number): string {
  const end = b.indexOf(0, from);
  return b.toString("latin1", from, end >= from && end < to ? end : to).trim();
}

function sizeOf(h: Buffer): number {
  if (h[124] & 0x80) {
    // GNU base-256 size, for entries past 8 GiB.
    let n = h[124] & 0x7f;
    for (let i = 125; i < 136; i++) n = n * 256 + h[i];
    return n;
  }
  const t = fieldText(h, 124, 136);
  return t === "" ? 0 : /^[0-7]+$/.test(t) ? parseInt(t, 8) : NaN;
}

function checksumOk(h: Buffer): boolean {
  const t = fieldText(h, 148, 156);
  if (!/^[0-7]+$/.test(t)) return false;
  const want = parseInt(t, 8);
  let unsigned = 0;
  let signed = 0;
  for (let i = 0; i < BLOCK; i++) {
    const v = i >= 148 && i < 156 ? 32 : h[i];
    unsigned += v;
    signed += v > 127 ? v - 256 : v;
  }
  return want === unsigned || want === signed;
}

export async function checkTarFile(file: string): Promise<TarCheck> {
  const fd = await fs.promises.open(file, "r");
  try {
    const total = (await fd.stat()).size;
    const h = Buffer.alloc(BLOCK);
    let off = 0;
    let entries = 0;
    for (;;) {
      if (off === total) return { ok: true, entries, bytes: total };
      if (off + BLOCK > total) {
        return { ok: false, entry: entries, offsetBytes: off, reason: "the file ends inside an entry header." };
      }
      await fd.read(h, 0, BLOCK, off);
      if (h.every((v) => v === 0)) return { ok: true, entries, bytes: total };
      if (!checksumOk(h)) {
        return {
          ok: false,
          entry: entries,
          offsetBytes: off,
          reason: "an entry header is not a tar header (bad header checksum), so the archive is damaged here.",
        };
      }
      const type = String.fromCharCode(h[156]);
      const size = DATA_TYPES.has(type) ? sizeOf(h) : 0;
      if (!Number.isFinite(size)) {
        return { ok: false, entry: entries, offsetBytes: off, reason: "an entry's size is not a number." };
      }
      const dataEnd = off + BLOCK + size;
      if (dataEnd > total) {
        return {
          ok: false,
          entry: entries,
          offsetBytes: off,
          reason: `an entry's data runs ${dataEnd - total} bytes past the end of the file (the copy is short).`,
        };
      }
      if (!EXTENSION_TYPES.has(type)) entries++;
      off += BLOCK + Math.ceil(size / BLOCK) * BLOCK;
    }
  } finally {
    await fd.close();
  }
}

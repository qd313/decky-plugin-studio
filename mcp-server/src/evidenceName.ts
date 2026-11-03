/**
 * Naming the files a run leaves behind (plan 12, lane C).
 *
 * bonsAI's runs/ folder held 457 evidence files whose names were typed by
 * hand, one per device row. `saveAs` lets the caller name the file in the call
 * that makes it, and `rowId` is the testing row the file belongs to; both are
 * also read by the ledger (ledger.ts), which is how a report finds the file.
 *
 * Two rules, both about where a name can take a file:
 *   - A name is a file NAME. Anything before the last / or \ is dropped, so
 *     `../../x` and `C:\Windows\x` both become `x` inside runs/ (or
 *     screenshots/, recordings/). It cannot leave the folder.
 *   - The file keeps its real extension. `saveAs: "p89-open"` for a JSON
 *     evidence file is `p89-open.json`; `p89-open.json` is left alone; a name
 *     that already ends in some other extension gets the real one added
 *     (`notes.txt` -> `notes.txt.json`), so a PNG can never be called `.json`.
 *
 * `runName` keeps its old behaviour exactly (same replace, ".json" always
 * appended) so a caller that already uses it sees no change. `saveAs` wins
 * when both are given.
 *
 * A name that already exists is overwritten, as `runName` always did: naming a
 * file is asking for that file.
 */
import fs from "fs";
import path from "path";
import { getWorkspaceArtifactsDir } from "./tools/captureOrchestrator.js";

const MAX_NAME = 120;
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

/** One safe file name from whatever the caller typed, or "" when nothing usable is left. */
export function sanitizeEvidenceName(raw: string): string {
  const last = String(raw ?? "").trim().split(/[\\/]/).pop() ?? "";
  let name = last
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .replace(/\.{2,}/g, "_")
    .replace(/^[.]+/, "");
  if (name.length > MAX_NAME) name = name.slice(0, MAX_NAME);
  if (!name || /^[_.-]+$/.test(name)) return "";
  if (WINDOWS_RESERVED.test(name)) name = `_${name}`;
  return name;
}

/** `name` with `ext` on the end, once. `ext` is written with its dot (".json"). */
export function withExtension(name: string, ext: string): string {
  return name.toLowerCase().endsWith(ext.toLowerCase()) ? name : name + ext;
}

/** A sanitised, extension-bearing file name for `saveAs`, or null when `saveAs` is empty or has nothing usable. */
export function saveAsFileName(saveAs: string | null | undefined, ext: string): string | null {
  if (saveAs == null) return null;
  const clean = sanitizeEvidenceName(saveAs);
  return clean ? withExtension(clean, ext) : null;
}

/**
 * The full path of an evidence file: `saveAs` if it names something, else the
 * old `runName` rule, else `<fallback><ext>`.
 */
export function evidencePath(
  dir: string,
  opts: { saveAs?: string | null; runName?: string | null; fallback: string; ext: string },
): string {
  const named = saveAsFileName(opts.saveAs, opts.ext);
  if (named) return path.join(dir, named);
  const base = (opts.runName ?? opts.fallback).replace(/[^A-Za-z0-9._-]/g, "_");
  return path.join(dir, `${base}${opts.ext}`);
}

/** A row id as the ledger and the evidence file carry it: a trimmed string, at most 200 characters, or undefined. */
export function cleanRowId(v: unknown): string | undefined {
  if (typeof v !== "string" && typeof v !== "number") return undefined;
  const s = String(v).trim();
  return s ? s.slice(0, 200) : undefined;
}

/**
 * For the tools that had no evidence file of their own (deck_walkTo,
 * deck_assertFocusMove, deck_snapshotSettings): when the caller passed
 * `saveAs`, write the result as JSON under runs/ and say where. Without
 * `saveAs` the result is returned untouched (a bare `rowId` only reaches the
 * ledger). A write that fails is reported on the result as `evidenceError`; it
 * never turns a finished run into an exception.
 */
export function attachNamedEvidence<T extends object>(
  tool: string,
  result: T,
  opts: { saveAs?: string; rowId?: string },
): T & { evidenceFile?: string; evidenceError?: string; rowId?: string } {
  const out = result as T & { evidenceFile?: string; evidenceError?: string; rowId?: string };
  if (!saveAsFileName(opts.saveAs, ".json")) return out;
  try {
    const file = evidencePath(getWorkspaceArtifactsDir("runs"), {
      saveAs: opts.saveAs,
      fallback: tool,
      ext: ".json",
    });
    const body = { tool, ...(opts.rowId ? { rowId: opts.rowId } : {}), ...(result as object) };
    fs.writeFileSync(file, JSON.stringify(body, null, 2) + "\n", "utf8");
    out.evidenceFile = file;
    if (opts.rowId) out.rowId = opts.rowId;
  } catch (err) {
    out.evidenceError = `evidence file could not be written: ${(err as Error).message}`;
  }
  return out;
}

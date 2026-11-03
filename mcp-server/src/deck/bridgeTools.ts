/**
 * Locating the bridge board's helper scripts.
 *
 * Split out of pressButton.ts so the killswitch can find pad.py without
 * importing the module whose presses it exists to stop. That import would be a
 * cycle -- pressButton asks the killswitch whether it is allowed to press --
 * and a cycle in the one code path that must work when everything else has gone
 * wrong is not worth the convenience of leaving it where it was.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

/**
 * Find bridge/tools/<name> by walking up from this module. The MCP server runs
 * from dist/ in the repo and from resources/ inside the VSIX, so a fixed
 * relative path would be right in exactly one of those.
 */
export function findBridgeTool(name: string): string | null {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    const candidate = path.join(dir, "bridge", "tools", name);
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

export function findPadTool(): string | null {
  return findBridgeTool("pad.py");
}

/**
 * What `bridgeFirmware` reads when the board answered a status query and that
 * reply carried no "fw" field. Only a board flashed before `07_version` does
 * that, and the string says so. It is the whole of what this knows: the resting
 * axes also differ between `05` and `06`, but a program is named by what it
 * says, never by a guess from the axes.
 */
export const FIRMWARE_PRE_07 = "unknown (pre-07)";
/** The board was not asked, or did not answer, so nothing about its program is known. */
export const FIRMWARE_NOT_READ = "unknown (board not reached)";
/** The board is on another session's lease, so the status poll stayed off its port. */
export const FIRMWARE_NOT_PROBED = "unknown (not probed)";

export interface StatusReading {
  /** A status reply (a line with `"t":"status"`) was found in the text. */
  replied: boolean;
  /** The reply's "fw" string, or null when the reply had none. */
  firmware: string | null;
}

/**
 * Find the board's status reply in what `pad.py status` printed (`-> ` for what
 * it sent, `<- ` for what came back) and read its "fw". Reads only; a line that
 * is not JSON, or is not the status reply, is skipped. Several status lines
 * (the open-time probe can echo one) are fine: the last one wins.
 */
export function parseStatusFirmware(text: string): StatusReading {
  let reading: StatusReading = { replied: false, firmware: null };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim().replace(/^<-\s*/, "");
    if (!line.startsWith("{")) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (!obj || typeof obj !== "object") continue;
    const o = obj as { t?: unknown; ok?: unknown; fw?: unknown };
    // The `-> {"t":"status"}` line pad.py echoes has no "ok"; only a reply does.
    if (o.t !== "status" || o.ok !== true) continue;
    reading = { replied: true, firmware: typeof o.fw === "string" && o.fw.trim() ? o.fw.trim() : null };
  }
  return reading;
}

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

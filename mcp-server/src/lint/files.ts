/**
 * Shared source-file walker.
 *
 * Moved here from preview/rpcDiff.ts so the focus linter and the RPC differ walk
 * a plugin the same way. The behaviour is deliberately identical to what
 * rpcDiff.ts did before the move: skip node_modules and dist, match
 * .ts/.tsx/.js/.jsx, recurse everything else.
 *
 * Do not add configuration here. Two callers disagreeing about which files
 * count is a source of bugs, not a feature.
 */
import fs from "fs";
import path from "path";

export function walkSourceFiles(dir: string, out: string[]): void {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkSourceFiles(full, out);
    } else if (/\.(tsx?|jsx?)$/.test(entry.name)) {
      out.push(full);
    }
  }
}

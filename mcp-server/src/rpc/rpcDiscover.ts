import fs from "fs";
import path from "path";
import { getWorkspaceRoot } from "../config.js";

/** Parse `class Plugin` public methods from main.py (def / async def, no leading _). */
export function discoverPluginRpcMethods(mainPyPath: string): string[] {
  if (!fs.existsSync(mainPyPath)) return [];
  const src = fs.readFileSync(mainPyPath, "utf8");
  const methods = new Set<string>();

  const classMatch = src.match(/class\s+Plugin\s*(?:\([^)]*\))?\s*:/);
  if (!classMatch || classMatch.index === undefined) return [];

  const body = src.slice(classMatch.index);
  const methodRe = /^\s+(?:async\s+)?def\s+([a-zA-Z_][\w]*)\s*\(/gm;
  let match: RegExpExecArray | null;
  let depth = 0;
  const lines = body.split("\n");
  let inClass = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (i === 0) {
      inClass = true;
      continue;
    }
    if (!inClass) continue;

    const indent = line.match(/^(\s*)/)?.[1].length ?? 0;
    if (line.trim() && indent === 0 && !line.trim().startsWith("#")) break;

    const m = line.match(/^\s+(?:async\s+)?def\s+([a-zA-Z_][\w]*)\s*\(/);
    if (m) {
      const name = m[1];
      if (!name.startsWith("_")) methods.add(name);
    }
  }

  // Fallback regex on class body if line parser missed nested defs
  if (methods.size === 0) {
    const classBodyEnd = body.search(/\n\S/);
    const slice = classBodyEnd > 0 ? body.slice(0, classBodyEnd + 5000) : body.slice(0, 8000);
    while ((match = methodRe.exec(slice)) !== null) {
      const name = match[1];
      if (!name.startsWith("_")) methods.add(name);
    }
  }

  return [...methods].sort();
}

export function discoverWorkspaceRpcMethods(workspaceRoot?: string): string[] {
  const root = workspaceRoot ?? getWorkspaceRoot();
  return discoverPluginRpcMethods(path.join(root, "main.py"));
}

import fs from "fs";
import path from "path";

/** Paths copied from plugin workspace to Deck homebrew/plugins/<name>/ */
export const DEPLOY_COPY_ENTRIES = [
  "dist",
  "main.py",
  "plugin.json",
  "package.json",
  "assets",
  "py_modules",
  "defaults",
  "bin",
  "locales",
] as const;

const ROOT_PY_SKIP = new Set(["setup.py", "conftest.py"]);

/** Additional root-level *.py helpers (e.g. refactor_helpers.py). */
export function listRootPythonHelpers(pluginRoot: string): string[] {
  if (!fs.existsSync(pluginRoot)) return [];
  return fs
    .readdirSync(pluginRoot, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".py") && !ROOT_PY_SKIP.has(e.name))
    .map((e) => e.name)
    .filter((name) => name !== "main.py");
}

export function listDeploySources(pluginRoot: string): string[] {
  const sources: string[] = [];
  for (const entry of DEPLOY_COPY_ENTRIES) {
    if (fs.existsSync(path.join(pluginRoot, entry))) {
      sources.push(entry);
    }
  }
  for (const py of listRootPythonHelpers(pluginRoot)) {
    sources.push(py);
  }
  return sources;
}

export function copyEntry(src: string, dest: string): void {
  if (!fs.existsSync(src)) return;
  if (fs.statSync(src).isDirectory()) {
    fs.cpSync(src, dest, { recursive: true });
  } else {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }
}

export function copyPluginTree(pluginRoot: string, targetDir: string): string[] {
  fs.mkdirSync(targetDir, { recursive: true });
  const copied: string[] = [];
  for (const rel of listDeploySources(pluginRoot)) {
    const src = path.join(pluginRoot, rel);
    const dest = path.join(targetDir, rel);
    copyEntry(src, dest);
    copied.push(rel);
  }
  return copied;
}

import * as fs from "fs";
import * as path from "path";
import { getRepoRoot } from "../paths";

function copyTree(src: string, dest: string, skipExisting: boolean): number {
  if (!fs.existsSync(src)) return 0;
  let copied = 0;
  if (fs.statSync(src).isFile()) {
    if (skipExisting && fs.existsSync(dest)) return 0;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
    return 1;
  }
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copied += copyTree(s, d, skipExisting);
    } else if (!skipExisting || !fs.existsSync(d)) {
      fs.mkdirSync(path.dirname(d), { recursive: true });
      fs.copyFileSync(s, d);
      copied++;
    }
  }
  return copied;
}

/** Copy optional studio templates into plugin workspace (skip existing files). */
export function copyStudioTemplates(workspaceRoot: string): number {
  const repoRoot = getRepoRoot();
  let total = 0;

  const mappings: Array<{ src: string; dest: string }> = [
    {
      src: path.join(repoRoot, "templates", "preview-suite", "scripts", "run-preview-suite.mjs"),
      dest: path.join(workspaceRoot, "scripts", "run-preview-suite.mjs"),
    },
    {
      src: path.join(repoRoot, "templates", "preview-suite", "tests", "preview-suite"),
      dest: path.join(workspaceRoot, "tests", "preview-suite"),
    },
    {
      src: path.join(repoRoot, "templates", "preview-suite", "docs", "device-qa-runbook.md"),
      dest: path.join(workspaceRoot, "docs", "device-qa-runbook.md"),
    },
    {
      src: path.join(repoRoot, "templates", ".env.example"),
      dest: path.join(workspaceRoot, ".env.example"),
    },
    {
      src: path.join(repoRoot, "templates", "scripts"),
      dest: path.join(workspaceRoot, "scripts"),
    },
    {
      src: path.join(repoRoot, "templates", "test-harness"),
      dest: path.join(workspaceRoot, "src", "test-harness"),
    },
    {
      src: path.join(repoRoot, "templates", "debug"),
      dest: path.join(workspaceRoot, "src", "preview", "debug"),
    },
    {
      src: path.join(repoRoot, "pack", ".decky"),
      dest: path.join(workspaceRoot, ".decky"),
    },
  ];

  for (const { src, dest } of mappings) {
    if (fs.existsSync(src)) {
      if (fs.statSync(src).isFile()) {
        if (!fs.existsSync(dest)) {
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          fs.copyFileSync(src, dest);
          total++;
        }
      } else {
        total += copyTree(src, dest, true);
      }
    }
  }
  return total;
}

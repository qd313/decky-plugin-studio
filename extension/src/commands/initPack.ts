import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { getPackRoot } from "../paths";

type ConflictAction = "overwrite" | "skip" | "review" | "cancel";

interface PackFile {
  relativePath: string;
  sourcePath: string;
}

function collectPackFiles(packRoot: string, base = ""): PackFile[] {
  const entries = fs.readdirSync(path.join(packRoot, base), { withFileTypes: true });
  const files: PackFile[] = [];
  for (const entry of entries) {
    const rel = base ? path.join(base, entry.name) : entry.name;
    const full = path.join(packRoot, rel);
    if (entry.isDirectory()) {
      files.push(...collectPackFiles(packRoot, rel));
    } else {
      files.push({ relativePath: rel.replace(/\\/g, "/"), sourcePath: full });
    }
  }
  return files;
}

async function pickConflictAction(): Promise<ConflictAction> {
  const choice = await vscode.window.showQuickPick(
    [
      { label: "Overwrite all", value: "overwrite" as const },
      { label: "Skip existing (only add missing files)", value: "skip" as const },
      { label: "Review each one", value: "review" as const, description: "default" },
      { label: "Cancel", value: "cancel" as const },
    ],
    { title: "Decky: Init pack — conflicts found", placeHolder: "Choose action for all conflicts" }
  );
  return choice?.value ?? "cancel";
}

const MCP_TEMPLATE_PATHS = new Set(["mcp.json", ".vscode/mcp.json", ".mcp.json"]);

function isMcpTemplate(relativePath: string): boolean {
  return MCP_TEMPLATE_PATHS.has(relativePath.replace(/\\/g, "/"));
}

type PackTarget = "cursor" | "claude" | "both";

/**
 * Files that belong to exactly one editor. Everything else in the pack (AGENTS.md,
 * docs/, .decky/, .github/) is editor-neutral and always copied.
 */
function targetOf(relativePath: string): "cursor" | "claude" | "shared" {
  const p = relativePath.replace(/\\/g, "/");
  if (p.startsWith(".cursor/") || p === "mcp.json") return "cursor";
  if (p.startsWith(".claude/") || p === ".mcp.json" || p === "CLAUDE.md") return "claude";
  return "shared";
}

function filterByTarget(files: PackFile[], target: PackTarget): PackFile[] {
  if (target === "both") return files;
  return files.filter((f) => {
    const owner = targetOf(f.relativePath);
    return owner === "shared" || owner === target;
  });
}

async function pickTarget(): Promise<PackTarget | undefined> {
  const choice = await vscode.window.showQuickPick(
    [
      {
        label: "Both",
        description: "default",
        detail: "Cursor rules/agents/skills and Claude Code agents/skills/hooks",
        value: "both" as const,
      },
      {
        label: "Cursor",
        detail: ".cursor/ rules, agents, skills, hooks + mcp.json",
        value: "cursor" as const,
      },
      {
        label: "Claude Code",
        detail: ".claude/ agents, skills, settings hooks + CLAUDE.md + .mcp.json",
        value: "claude" as const,
      },
    ],
    {
      title: "Decky: Init pack — which agent setup?",
      placeHolder: "Editor-neutral files (AGENTS.md, docs, .decky, scripts) are copied either way",
    }
  );
  return choice?.value;
}

async function writeMcpTemplate(sourcePath: string, targetPath: string): Promise<void> {
  const { getMcpServerEntry } = await import("../paths");
  let content = fs.readFileSync(sourcePath, "utf8");
  content = content.replace(/__DECKY_MCP_ENTRY__/g, getMcpServerEntry().replace(/\\/g, "/"));
  fs.writeFileSync(targetPath, content, "utf8");
}

async function reviewFile(
  workspaceRoot: string,
  packFile: PackFile
): Promise<"keep" | "take" | "skip"> {
  const target = path.join(workspaceRoot, packFile.relativePath);
  const choice = await vscode.window.showQuickPick(
    [
      { label: "Keep mine", value: "keep" as const },
      { label: "Take pack", value: "take" as const },
      { label: "Skip", value: "skip" as const },
    ],
    { title: `Conflict: ${packFile.relativePath}` }
  );
  if (choice?.value === "take") {
    await vscode.commands.executeCommand(
      "vscode.diff",
      vscode.Uri.file(packFile.sourcePath),
      vscode.Uri.file(target),
      `${packFile.relativePath} (pack ↔ workspace)`
    );
  }
  return choice?.value ?? "skip";
}

export async function initPack(targetRoot?: string): Promise<void> {
  const workspaceRoot = targetRoot ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceRoot) {
    vscode.window.showErrorMessage("Open a workspace folder first.");
    return;
  }

  const packRoot = getPackRoot();
  if (!fs.existsSync(packRoot)) {
    vscode.window.showErrorMessage(`Pack not found at ${packRoot}`);
    return;
  }

  const target = await pickTarget();
  if (!target) return;

  const files = filterByTarget(collectPackFiles(packRoot), target);
  const conflicts = files.filter((f) => fs.existsSync(path.join(workspaceRoot, f.relativePath)));

  let action: ConflictAction = conflicts.length === 0 ? "overwrite" : await pickConflictAction();
  if (action === "cancel") return;

  let copied = 0;
  let skipped = 0;

  for (const file of files) {
    const target = path.join(workspaceRoot, file.relativePath);
    const exists = fs.existsSync(target);

    if (exists) {
      if (action === "skip") {
        skipped++;
        continue;
      }
      if (action === "review") {
        const decision = await reviewFile(workspaceRoot, file);
        if (decision === "keep" || decision === "skip") {
          skipped++;
          continue;
        }
      }
    }

    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (isMcpTemplate(file.relativePath)) {
      await writeMcpTemplate(file.sourcePath, target);
    } else {
      fs.copyFileSync(file.sourcePath, target);
    }
    copied++;
  }

  const targetLabel =
    target === "both" ? "Cursor + Claude Code" : target === "claude" ? "Claude Code" : "Cursor";
  vscode.window.showInformationMessage(
    `Decky: Init pack complete (${targetLabel}) — ${copied} file(s) copied, ${skipped} skipped.`
  );

  const { copyStudioTemplates } = await import("./copyTemplates");
  const templatesCopied = copyStudioTemplates(workspaceRoot);
  if (templatesCopied > 0) {
    vscode.window.showInformationMessage(
      `Decky: ${templatesCopied} template file(s) added (preview suite, scripts, harness).`
    );
  }
}

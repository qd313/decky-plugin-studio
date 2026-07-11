import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { initPack } from "./initPack";

const TEMPLATE_URL = "https://github.com/SteamDeckHomebrew/decky-plugin-template.git";

interface RenameRule {
  from: string;
  to: string;
}

const DEFAULT_RENAMES: RenameRule[] = [
  { from: "decky-plugin-template", to: "{{kebab}}" },
  { from: "Decky Plugin Template", to: "{{display}}" },
  { from: "John Doe", to: "{{author}}" },
];

function toKebab(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function toDisplay(name: string): string {
  return name
    .trim()
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

async function cloneTemplate(targetDir: string): Promise<void> {
  const { execSync } = await import("child_process");
  execSync(`git clone --depth 1 ${TEMPLATE_URL} "${targetDir}"`, { stdio: "inherit" });
  const gitDir = path.join(targetDir, ".git");
  if (fs.existsSync(gitDir)) {
    fs.rmSync(gitDir, { recursive: true, force: true });
  }
}

function walkFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      out.push(...walkFiles(full));
    } else {
      out.push(full);
    }
  }
  return out;
}

function applyRenames(root: string, kebab: string, display: string, author: string): number {
  let count = 0;
  const textExtensions = new Set([
    ".json", ".md", ".ts", ".tsx", ".js", ".py", ".html", ".css", ".yml", ".yaml", ".txt",
  ]);

  for (const file of walkFiles(root)) {
    const ext = path.extname(file).toLowerCase();
    if (!textExtensions.has(ext)) continue;
    let content = fs.readFileSync(file, "utf8");
    let changed = false;
    for (const rule of DEFAULT_RENAMES) {
      const replacement = rule.to
        .replace("{{kebab}}", kebab)
        .replace("{{display}}", display)
        .replace("{{author}}", author);
      if (content.includes(rule.from)) {
        content = content.split(rule.from).join(replacement);
        changed = true;
      }
    }
    if (changed) {
      fs.writeFileSync(file, content, "utf8");
      count++;
    }
  }
  return count;
}

export async function createPlugin(): Promise<void> {
  const nameInput = await vscode.window.showInputBox({
    prompt: "Plugin name (kebab-case)",
    placeHolder: "my-cool-plugin",
    validateInput: (v) => (toKebab(v).length > 0 ? null : "Enter a valid name"),
  });
  if (!nameInput) return;

  const displayInput = await vscode.window.showInputBox({
    prompt: "Display name (shown in QAM)",
    value: toDisplay(nameInput),
  });
  if (!displayInput) return;

  const authorInput = await vscode.window.showInputBox({
    prompt: "Author",
    placeHolder: "Jane Dev",
  });
  if (!authorInput) return;

  const templatePick = await vscode.window.showQuickPick(
    [
      {
        label: "decky-plugin-template",
        description: "official, recommended",
        detail: "Python backend + React/TS frontend, rollup, vitest",
        value: "official" as const,
      },
      { label: "minimal-py-only", description: "Python-only, no frontend", value: "minimal" as const },
      { label: "frontend-only", description: "No main.py — UI-only", value: "frontend" as const },
    ],
    { title: "Decky: Create New Plugin — pick template" }
  );
  if (!templatePick) return;

  const folderPick = await vscode.window.showOpenDialog({
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    openLabel: "Select parent directory",
  });
  if (!folderPick?.[0]) return;

  const kebab = toKebab(nameInput);
  const targetDir = path.join(folderPick[0].fsPath, kebab);

  if (fs.existsSync(targetDir)) {
    vscode.window.showErrorMessage(`Directory already exists: ${targetDir}`);
    return;
  }

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "Decky: Create New Plugin",
      cancellable: false,
    },
    async (progress) => {
      progress.report({ message: "Cloning template…" });
      if (templatePick.value === "official") {
        await cloneTemplate(targetDir);
      } else {
        fs.mkdirSync(targetDir, { recursive: true });
        fs.writeFileSync(
          path.join(targetDir, "plugin.json"),
          JSON.stringify(
            {
              name: displayInput,
              author: authorInput,
              description: `${displayInput} Decky plugin`,
              version: "0.0.1",
              api_version: 1,
              main: templatePick.value === "minimal" ? "main.py" : undefined,
              flags: [],
            },
            null,
            2
          )
        );
        if (templatePick.value === "minimal") {
          fs.writeFileSync(
            path.join(targetDir, "main.py"),
            'import decky\n\nclass Plugin:\n    async def _main(self):\n        decky.logger.info("Plugin loaded")\n'
          );
        }
        if (templatePick.value === "frontend") {
          fs.mkdirSync(path.join(targetDir, "src"), { recursive: true });
          fs.writeFileSync(
            path.join(targetDir, "src", "index.tsx"),
            'import { definePlugin } from "@decky/api";\nexport default definePlugin(() => ({ name: "' +
              displayInput +
              '", content: <div>Hello</div> }));\n'
          );
        }
      }

      progress.report({ message: "Renaming identifiers…" });
      const renamed = applyRenames(targetDir, kebab, displayInput, authorInput);

      progress.report({ message: "Running Init pack…" });
      await initPack(targetDir);

      progress.report({ message: "Initializing git…" });
      try {
        const { execSync } = await import("child_process");
        execSync("git init", { cwd: targetDir, stdio: "ignore" });
      } catch {
        /* optional */
      }

      vscode.window
        .showInformationMessage(
          `Created ${kebab} — ${renamed} file(s) renamed, pack installed.`,
          "Open Folder"
        )
        .then((choice) => {
          if (choice === "Open Folder") {
            vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(targetDir), true);
          }
        });
    }
  );
}

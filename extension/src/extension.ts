import * as vscode from "vscode";
import { initPack } from "./commands/initPack";
import { createPlugin } from "./commands/createPlugin";
import { openPreview } from "./commands/openPreview";
import {
  deployToDeck,
  captureScreenshot,
  startTunnel,
  stopTunnel,
} from "./commands/deployToDeck";
import { DeckyTreeProvider } from "./ui/treeProvider";
import { DeckyStatusBar } from "./ui/statusBar";
import { getPreviewManager } from "./commands/openPreview";
import { spawnMcpProcess, stopMcpProcess, updateMcpState } from "./mcp/client";

let treeProvider: DeckyTreeProvider;
let statusBar: DeckyStatusBar;

export function activate(context: vscode.ExtensionContext): void {
  treeProvider = new DeckyTreeProvider();
  statusBar = new DeckyStatusBar(context);

  context.subscriptions.push(
    vscode.window.registerTreeDataProvider("deckyStudioTree", treeProvider),
    statusBar,
    vscode.commands.registerCommand("decky.initPack", () => initPack()),
    vscode.commands.registerCommand("decky.createPlugin", () => createPlugin()),
    vscode.commands.registerCommand("decky.openPreview", () => openPreview()),
    vscode.commands.registerCommand("decky.deployToDeck", () => deployToDeck()),
    vscode.commands.registerCommand("decky.captureScreenshot", () => captureScreenshot()),
    vscode.commands.registerCommand("decky.startTunnel", () => startTunnel()),
    vscode.commands.registerCommand("decky.stopTunnel", () => stopTunnel()),
    vscode.commands.registerCommand("decky.showOpenPluginHint", async () => {
      const { callMcpTool } = await import("../mcp/client");
      const result = (await callMcpTool("deck_openPlugin", {})) as {
        pluginName?: string;
        checklist?: string[];
      };
      const lines = result.checklist ?? [];
      vscode.window.showInformationMessage(
        `Open "${result.pluginName ?? "plugin"}" on Deck: ${lines[0] ?? "Open QAM → Decky → your plugin"}`
      );
    }),
    vscode.commands.registerCommand("decky.refreshTree", () => {
      treeProvider.refresh();
      statusBar.refresh();
    })
  );

  spawnMcpProcess()
    .then(async () => {
      const { callMcpTool } = await import("./mcp/client");
      try {
        const status = (await callMcpTool("deck_status", {})) as Record<string, unknown>;
        updateMcpState({
          tunnelRunning: Boolean(status.tunnelRunning),
          tunnelPid: status.tunnelPid as number | undefined,
          ingestCount: Number(status.ingestCount ?? 0),
          deckReachable: Boolean(status.deckReachable),
          ollamaReachable: Boolean(status.ollamaReachable),
        });
        treeProvider.refresh();
        statusBar.refresh();
      } catch {
        /* MCP warming up */
      }
    })
    .catch(() => {
      /* dev mode without built MCP */
    });

  context.subscriptions.push({
    dispose: () => {
      getPreviewManager().stop();
      stopMcpProcess();
    },
  });
}

export function deactivate(): void {
  getPreviewManager().stop();
  stopMcpProcess();
}

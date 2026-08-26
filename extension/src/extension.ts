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
import { spawnMcpProcess, stopMcpProcess, updateMcpState, showMcpOutput } from "./mcp/client";

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
      const { callMcpTool } = await import("./mcp/client");
      const result = (await callMcpTool("deck_openPlugin", {})) as {
        pluginName?: string;
        checklist?: string[];
      };
      const lines = result.checklist ?? [];
      vscode.window.showInformationMessage(
        `Open "${result.pluginName ?? "plugin"}" on Deck: ${lines[0] ?? "Open QAM → Decky → your plugin"}`
      );
    }),
    vscode.commands.registerCommand("decky.showMcpOutput", () => showMcpOutput()),
    vscode.commands.registerCommand("decky.refreshTree", () => {
      treeProvider.refresh();
      statusBar.refresh();
    })
  );

  /**
   * Re-read the server's view of the world.
   *
   * This used to run exactly once, at activation, with no timer anywhere. So
   * the bar was a snapshot of the first second of the session: start a tunnel
   * and it still said off, plug in the Deck and it still said unreachable. The
   * only way to update it was the refresh command, which you would only run if
   * you already suspected the bar was lying.
   */
  const pollStatus = async (): Promise<void> => {
    try {
      const { callMcpTool } = await import("./mcp/client");
      const status = (await callMcpTool("deck_status", {})) as Record<string, unknown>;
      updateMcpState({
        tunnelRunning: Boolean(status.tunnelRunning),
        tunnelPid: status.tunnelPid as number | undefined,
        ingestCount: Number(status.ingestCount ?? 0),
        deckReachable: Boolean(status.deckReachable),
        ollamaReachable: Boolean(status.ollamaReachable),
      });
    } catch {
      // Leave the state alone; the client already recorded why, and the status
      // bar reads that rather than showing this as "everything is off".
    }
    treeProvider.refresh();
    statusBar.refresh();
  };

  void spawnMcpProcess().then(pollStatus, pollStatus);

  // 30s: a ping with a 1s deadline plus one local HTTP probe, so it is cheap,
  // but not so frequent that it spawns subprocesses in a tight loop.
  const timer = setInterval(() => void pollStatus(), 30_000);
  context.subscriptions.push({ dispose: () => clearInterval(timer) });

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

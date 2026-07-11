import * as vscode from "vscode";
import { getMcpState } from "../mcp/client";
import { getPreviewManager } from "../commands/openPreview";

export class DeckyTreeProvider implements vscode.TreeDataProvider<DeckyTreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<DeckyTreeItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(element: DeckyTreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: DeckyTreeItem): DeckyTreeItem[] {
    if (element) {
      return element.children ?? [];
    }
    const state = getMcpState();
    const preview = getPreviewManager();
    const pluginName = vscode.workspace.workspaceFolders?.[0]?.name ?? "plugin";

    return [
      section("Preview", state.previewRunning, [
        leaf(state.previewRunning ? `${pluginName} (running)` : "not running"),
        leaf(state.previewUrl ?? "—"),
      ]),
      section("Tunnel", state.tunnelRunning, [
        leaf(state.tunnelRunning ? `pid ${state.tunnelPid ?? "?"}` : "not started"),
      ]),
      section("Ingest", state.ingestCount > 0, [
        leaf(`${state.ingestCount} events`),
      ]),
      section("Deck", state.deckReachable, [leaf(state.deckReachable ? "reachable" : "unreachable")]),
      section("Ollama", state.ollamaReachable, [
        leaf(state.ollamaReachable ? "reachable" : "not detected"),
        leaf("127.0.0.1:11434"),
      ]),
      section("Hardware sim", false, [
        leaf(`preset: ${state.hwPreset}`),
        leaf("profile: Steam Deck LCD"),
      ]),
      new DeckyTreeItem("── MCP tools ──", vscode.TreeItemCollapsibleState.Expanded, [
        tool("deck.startTunnel"),
        tool("deck.stopTunnel"),
        tool("deck.captureScreenshot"),
        tool("deck.record"),
        tool("deck.installCaptureHelper"),
        tool("deck.deploy"),
        tool("plugin.build"),
        tool("plugin.verifyZip"),
        tool("preview.start"),
        tool("preview.health"),
        tool("preview.runSequence"),
        tool("preview.callRpc"),
        tool("preview.callTestHook"),
        tool("preview.snapshotDom"),
        tool("preview.captureScreenshot"),
        tool("preview.setHardware"),
        tool("preview.setPermissions"),
      ]),
    ];
  }
}

class DeckyTreeItem extends vscode.TreeItem {
  constructor(
    label: string,
    collapsibleState: vscode.TreeItemCollapsibleState,
    public readonly children?: DeckyTreeItem[]
  ) {
    super(label, collapsibleState);
  }
}

function section(label: string, active: boolean, children: DeckyTreeItem[]): DeckyTreeItem {
  const item = new DeckyTreeItem(label, vscode.TreeItemCollapsibleState.Expanded, children);
  item.iconPath = new vscode.ThemeIcon(active ? "circle-filled" : "circle-outline");
  return item;
}

function leaf(label: string): DeckyTreeItem {
  return new DeckyTreeItem(label, vscode.TreeItemCollapsibleState.None);
}

function tool(name: string): DeckyTreeItem {
  const item = leaf(`▸ ${name}`);
  item.command = { command: "decky.refreshTree", title: "Refresh" };
  return item;
}

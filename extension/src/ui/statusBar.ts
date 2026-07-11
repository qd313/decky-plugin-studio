import * as vscode from "vscode";
import { getMcpState } from "../mcp/client";

export class DeckyStatusBar {
  private item: vscode.StatusBarItem;
  private extensionVersion: string;

  constructor(context: vscode.ExtensionContext) {
    this.extensionVersion = context.extension.packageJSON.version ?? "?";
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.item.command = "decky.openPreview";
    this.item.show();
    this.refresh();
  }

  refresh(): void {
    const s = getMcpState();
    const dot = (on: boolean) => (on ? "●" : "○");
    this.item.text = `Decky v${this.extensionVersion} | $(${s.previewRunning ? "play" : "debug-pause"}) Preview ${dot(s.previewRunning)} | ${dot(s.tunnelRunning)} Tunnel | ${s.ingestCount} ingest | ${dot(s.ollamaReachable)} Ollama | HW: ${s.hwPreset}`;
    this.item.tooltip = "Decky Plugin Studio (live preview is beta) — click to open preview";
  }

  dispose(): void {
    this.item.dispose();
  }
}

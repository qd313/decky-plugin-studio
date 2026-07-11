import * as vscode from "vscode";
import { getMcpState } from "../mcp/client";

export class DeckyStatusBar {
  private item: vscode.StatusBarItem;

  constructor() {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.item.command = "decky.openPreview";
    this.item.show();
    this.refresh();
  }

  refresh(): void {
    const s = getMcpState();
    const dot = (on: boolean) => (on ? "●" : "○");
    this.item.text = `$(${s.previewRunning ? "play" : "debug-pause"}) Preview ${dot(s.previewRunning)} | ${dot(s.tunnelRunning)} Tunnel | ${s.ingestCount} ingest | ${dot(s.ollamaReachable)} Ollama | HW: ${s.hwPreset}`;
    this.item.tooltip = "Decky Plugin Studio — click to open preview";
  }

  dispose(): void {
    this.item.dispose();
  }
}

import * as vscode from "vscode";
import { getMcpState, McpState } from "../mcp/client";

/**
 * The one always-visible surface Studio has.
 *
 * Two things here are deliberate, both from a 2026-08-26 report of "the status
 * bar is missing" (the real cause that time was the extension not being
 * installed in that editor at all -- but both of these produce the identical
 * symptom, and neither leaves a trace):
 *
 *   IT HAS AN id AND A name. Without them a user who hides the item has no
 *   findable entry in the status bar's right-click *Manage* menu, so hiding it
 *   once looks permanent.
 *
 *   THE TEXT STAYS SHORT. VS Code silently drops right-aligned items that do
 *   not fit, with no overflow affordance -- so a crowded bar or a narrow window
 *   makes a long item vanish. Detail belongs in the tooltip, which has no such
 *   limit; the text carries only what is worth a glance.
 */
export class DeckyStatusBar {
  private item: vscode.StatusBarItem;
  private extensionVersion: string;

  constructor(context: vscode.ExtensionContext) {
    this.extensionVersion = context.extension.packageJSON.version ?? "?";
    this.item = vscode.window.createStatusBarItem(
      "deckyPluginStudio.status",
      vscode.StatusBarAlignment.Right,
      100,
    );
    this.item.name = "Decky Plugin Studio";
    this.item.command = "decky.openPreview";
    this.item.show();
    this.refresh();
  }

  refresh(): void {
    const s = getMcpState();
    const dot = (on: boolean) => (on ? "●" : "○");

    // A dead server must not render as a row of "off" dots. Every signal below
    // is reported *by* the server, so when it is not running they are all false
    // for the same uninformative reason, and the bar ends up describing a
    // healthy Deck as unreachable.
    if (s.mcpHealth === "failed") {
      this.item.text = "$(warning) Decky (server failed)";
      this.item.command = "decky.showMcpOutput";
      this.item.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
      this.item.tooltip = new vscode.MarkdownString(
        [
          `**Decky Plugin Studio** v${this.extensionVersion}`,
          "",
          "The Studio server is not running, so none of the usual signals can be read.",
          "This is **not** a report that your Deck is offline.",
          "",
          "Click to open the log.",
          ...(s.mcpError ? ["", "```", s.mcpError.slice(0, 800), "```"] : []),
        ].join("\n"),
      );
      this.item.show();
      return;
    }

    this.item.command = "decky.openPreview";
    this.item.backgroundColor = undefined;
    this.item.text =
      `$(${s.previewRunning ? "play" : "debug-pause"}) Decky ` +
      `${dot(s.previewRunning)}${dot(s.tunnelRunning)}${dot(s.ollamaReachable)}`;
    this.item.tooltip = this.tooltipFor(s);
  }

  /** Everything the text used to carry, plus what it never had room for. */
  private tooltipFor(s: McpState): vscode.MarkdownString {
    const row = (label: string, on: boolean, extra = "") =>
      `| ${label} | ${on ? "● on" : "○ off"} | ${extra} |`;
    const md = new vscode.MarkdownString(
      [
        `**Decky Plugin Studio** v${this.extensionVersion}`,
        "",
        "| | | |",
        "|---|---|---|",
        row("Preview", s.previewRunning, "live preview is beta"),
        row("Tunnel", s.tunnelRunning),
        row("Deck", s.deckReachable),
        row("Ollama", s.ollamaReachable),
        `| Ingest | ${s.ingestCount} | events |`,
        `| Hardware | ${s.hwPreset} | |`,
        `| Server | ${s.mcpHealth} | |`,
        "",
        "Click to open the preview.",
      ].join("\n"),
    );
    md.supportThemeIcons = true;
    return md;
  }

  dispose(): void {
    this.item.dispose();
  }
}

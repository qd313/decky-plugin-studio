import * as vscode from "vscode";
import { spawnMcpProcess, getMcpState, callMcpTool } from "../mcp/client";

export async function deployToDeck(): Promise<void> {
  try {
    await spawnMcpProcess();
    const result = await callMcpTool("deck_deploy", { mode: "auto" });
    vscode.window.showInformationMessage(`Deploy: ${JSON.stringify(result)}`);
  } catch (err) {
    vscode.window.showErrorMessage(`Deploy failed: ${err}`);
  }
}

export async function captureScreenshot(): Promise<void> {
  try {
    await spawnMcpProcess();
    const result = (await callMcpTool("deck_captureScreenshot", { mode: "auto" })) as {
      path?: string;
    };
    if (result?.path) {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(result.path));
      await vscode.window.showTextDocument(doc, { preview: true });
    }
  } catch (err) {
    vscode.window.showErrorMessage(`Screenshot failed: ${err}`);
  }
}

export async function startTunnel(): Promise<void> {
  try {
    await spawnMcpProcess();
    const result = await callMcpTool("deck_startTunnel", {});
    vscode.window.showInformationMessage(`Tunnel started: ${JSON.stringify(result)}`);
    vscode.commands.executeCommand("decky.refreshTree");
  } catch (err) {
    vscode.window.showErrorMessage(`Tunnel failed: ${err}`);
  }
}

export async function stopTunnel(): Promise<void> {
  try {
    await spawnMcpProcess();
    await callMcpTool("deck_stopTunnel", {});
    vscode.window.showInformationMessage("Tunnel stopped.");
    vscode.commands.executeCommand("decky.refreshTree");
  } catch (err) {
    vscode.window.showErrorMessage(`Stop tunnel failed: ${err}`);
  }
}

export function getStudioState() {
  return getMcpState();
}

import * as vscode from "vscode";
import { spawnMcpProcess, getMcpState, callMcpTool } from "../mcp/client";

export async function deployToDeck(): Promise<void> {
  try {
    await spawnMcpProcess();
    const result = await callMcpTool("deck_deploy", { mode: "auto" });
    vscode.window.showInformationMessage(`Deploy: ${JSON.stringify(result)}`);
  } catch (err) {
    vscode.window.showErrorMessage(`Deploy failed: ${err}`);
  } finally {
    await releaseLease();
  }
}

/**
 * A one-shot command that drove the Deck took the machine's lease inside the
 * extension's own process. Without this it would sit there for up to ten
 * minutes and refuse an agent's next driving call. Never throws.
 */
async function releaseLease(): Promise<void> {
  try {
    await callMcpTool("deck_releaseMachine", {});
  } catch {
    /* nothing held, or the server is gone; either way there is no lease to leak */
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
  } finally {
    await releaseLease();
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

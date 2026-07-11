import * as vscode from "vscode";
import { PreviewManager } from "../preview/manager";

const previewManager = new PreviewManager();

export async function openPreview(): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    vscode.window.showErrorMessage("Open a Decky plugin workspace first.");
    return;
  }
  await previewManager.open(folder.uri.fsPath);
}

export function getPreviewManager(): PreviewManager {
  return previewManager;
}

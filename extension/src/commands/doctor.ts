import * as vscode from "vscode";
import { callMcpTool } from "../mcp/client";

interface DoctorCheck {
  name: string;
  ok: boolean | "unknown";
  saw: string;
  fix: string;
}
interface DoctorReport {
  checks: DoctorCheck[];
  okCount: number;
  failCount: number;
  unknownCount?: number;
}

let channel: vscode.OutputChannel | null = null;

/** Run studio_doctor and print the result, failures first. */
export async function runDoctor(context: vscode.ExtensionContext): Promise<void> {
  channel ??= vscode.window.createOutputChannel("Decky Plugin Studio Doctor");
  const out = channel;
  out.clear();
  out.show(true);
  try {
    const workspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const report = (await callMcpTool("studio_doctor", {
      ...(workspace ? { workspace } : {}),
      extensionVersion: String(context.extension.packageJSON.version),
    })) as DoctorReport;
    out.appendLine(
      `Decky Plugin Studio doctor: ${report.failCount} failing, ${report.okCount} ok, ${report.unknownCount ?? 0} could not be checked`,
    );
    out.appendLine("");
    const rank = (c: DoctorCheck): number => (c.ok === false ? 0 : c.ok === "unknown" ? 1 : 2);
    for (const c of [...report.checks].sort((a, b) => rank(a) - rank(b))) {
      const tag = c.ok === true ? "ok     " : c.ok === false ? "FAIL   " : "unknown";
      out.appendLine(`[${tag}] ${c.name}`);
      out.appendLine(`          saw: ${c.saw}`);
      if (c.fix) out.appendLine(`          fix: ${c.fix}`);
    }
    if (report.failCount > 0) {
      vscode.window.showWarningMessage(`Studio doctor: ${report.failCount} check(s) failing. See the output panel.`);
    } else {
      vscode.window.showInformationMessage("Studio doctor: no failing checks.");
    }
  } catch (err) {
    out.appendLine(`The doctor could not run: ${err}`);
    vscode.window.showErrorMessage(`Studio doctor could not run: ${err}`);
  }
}

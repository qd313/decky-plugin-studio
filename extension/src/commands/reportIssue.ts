import * as vscode from "vscode";
import { callMcpTool } from "../mcp/client";

/** What studio_reportIssue returns that this command uses. */
interface ReportResult {
  title: string;
  markdown: string;
  labels: string[];
  confirmToken: string;
  redaction: { replacements: number };
  gh: { authenticated: boolean | "unknown"; detail: string };
  prefilledUrl: string;
  urlTruncated: boolean;
  posted?: boolean;
  issueUrl?: string;
  labelsApplied?: boolean;
  summary: string;
}

const SURFACES: Array<{ label: string; surface?: string; description: string }> = [
  { label: "server", surface: "server", description: "the MCP server (a tool answered wrong, hung or threw)" },
  { label: "extension", surface: "extension", description: "this editor extension (a command, the tree, the status bar)" },
  { label: "deck", surface: "deck", description: "the real Steam Deck" },
  { label: "standin", surface: "standin", description: "a stand-in Deck (a VM, or this PC running Big Picture)" },
  { label: "not sure", description: "leave the surface label off" },
];

/**
 * Decky: Report Studio Issue.
 *
 * Asks for a title and a few words, runs studio_reportIssue as a dry run, and
 * shows the markdown it returned in an untitled editor. Only then does it offer
 * to post. Posting sends the text the server handed out, matched by its
 * confirmToken, not what the editor holds now, so an edit made there is not
 * sent (the quick-pick says so). Nothing leaves this machine before the pick.
 */
export async function reportStudioIssue(context: vscode.ExtensionContext): Promise<void> {
  try {
    const title = await vscode.window.showInputBox({
      title: "Report a Studio issue (1 of 3)",
      prompt: "A short title",
      ignoreFocusOut: true,
      validateInput: (v) => (v.trim() ? (v.length > 200 ? "Keep it under 200 characters" : null) : "A title is required"),
    });
    if (!title) return;
    const body = await vscode.window.showInputBox({
      title: "Report a Studio issue (2 of 3)",
      prompt: "What happened, what you expected, what you did. The diagnostic bundle is added for you.",
      ignoreFocusOut: true,
      validateInput: (v) => (v.trim() ? null : "Say what happened"),
    });
    if (!body) return;
    const pick = await vscode.window.showQuickPick(SURFACES, {
      title: "Report a Studio issue (3 of 3)",
      placeHolder: "Where did it go wrong?",
      ignoreFocusOut: true,
    });
    if (!pick) return;

    const workspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const common = {
      title,
      body,
      source: "human",
      ...(pick.surface ? { surface: pick.surface } : {}),
      ...(workspace ? { workspace } : {}),
      extensionVersion: String(context.extension.packageJSON.version),
    };

    const dry = (await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "Collecting the diagnostic bundle..." },
      () => callMcpTool("studio_reportIssue", common),
    )) as ReportResult;

    const doc = await vscode.workspace.openTextDocument({ language: "markdown", content: dry.markdown });
    await vscode.window.showTextDocument(doc, { preview: false });

    const ghReady = dry.gh.authenticated === true;
    const choice = await vscode.window.showQuickPick(
      [
        {
          label: "Post with gh",
          description: ghReady ? "creates the issue now" : "gh is not signed in: this will open the prefilled page instead",
          action: "post",
        },
        { label: "Open prefilled URL", description: "opens the new-issue page in your browser; you press Submit", action: "url" },
        { label: "Cancel", description: "nothing is sent", action: "cancel" },
      ],
      {
        title: `Post "${dry.title}"?`,
        placeHolder: `Read the markdown first. ${dry.redaction.replacements} value(s) were redacted, which cannot catch everything. What is posted is what the server showed, not later edits.`,
        ignoreFocusOut: true,
      },
    );
    if (!choice || choice.action === "cancel") return;

    if (choice.action === "url") {
      await openPrefilled(dry);
      return;
    }

    const post = (await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "Posting with gh..." },
      () => callMcpTool("studio_reportIssue", { ...common, dryRun: false, confirmToken: dry.confirmToken }),
    )) as ReportResult;

    if (post.posted && post.issueUrl) {
      const open = await vscode.window.showInformationMessage(
        `Filed ${post.issueUrl}${post.labelsApplied === false ? " (without labels: the repo lacks them)" : ""}`,
        "Open issue",
      );
      if (open) void vscode.env.openExternal(vscode.Uri.parse(post.issueUrl));
      return;
    }
    const fallback = await vscode.window.showWarningMessage(post.summary, "Open prefilled URL");
    if (fallback) await openPrefilled(post);
  } catch (err) {
    void vscode.window.showErrorMessage(`Report Studio Issue failed: ${(err as Error).message ?? err}`);
  }
}

async function openPrefilled(r: ReportResult): Promise<void> {
  if (r.urlTruncated) {
    // The link cannot carry the whole bundle. The full text goes on the clipboard so the page can be pasted into.
    await vscode.env.clipboard.writeText(r.markdown);
    void vscode.window.showInformationMessage("The link is shorter than the issue. The full markdown is on your clipboard: paste it into the body.");
  }
  await vscode.env.openExternal(vscode.Uri.parse(r.prefilledUrl));
}

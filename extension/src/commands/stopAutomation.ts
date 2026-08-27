import * as os from "os";
import * as vscode from "vscode";
import { callMcpControl, callMcpTool } from "../mcp/client";
import { readLatch, writeLatch, clearLatch, StopSource } from "../automation/latch";

interface StopReport {
  ok?: boolean;
  alreadyStopped?: boolean;
  release?: { attempted?: boolean; ok?: boolean; detail?: string };
  tunnels?: { closed?: number; failed?: number; byKind?: { cdp?: number; ingest?: number } };
  summary?: string;
}

/**
 * Stop everything.
 *
 * THE LATCH IS SET HERE, FIRST, IN THIS PROCESS. Not by asking the server to do
 * it. The server is a child process that can be dead, wedged, or -- most likely
 * of all at the moment somebody hits this -- busy in the middle of the very run
 * they are trying to stop. Waiting on a round trip before the rig is disarmed
 * would make the stop take exactly as long as whatever is going wrong.
 *
 * Writing the file is the whole guarantee: every press in every Studio process
 * checks it immediately before it spawns, so from that write onwards nothing
 * can press. The server call that follows does the parts a file cannot -- tell
 * the board to drop whatever it is holding, kill the SSH tunnels -- and if it
 * fails, the user is told precisely which of those did not happen rather than
 * being handed a green tick.
 */
export async function stopAutomation(by: StopSource = "command"): Promise<void> {
  const already = readLatch();

  const latched = writeLatch(
    already ?? {
      at: new Date().toISOString(),
      by,
      reason: `stopped from the ${by === "keybinding" ? "keyboard" : by} in the editor`,
      pid: process.pid,
      host: os.hostname(),
    },
  );

  if (!latched) {
    // The one genuinely bad outcome: the stop did not take and there is no
    // point being calm about it. Modal, because this must not scroll past.
    await vscode.window.showErrorMessage(
      "Could not write the Deck automation killswitch latch. Automation is NOT stopped. " +
        "Unplug the bridge board's USB side from the Deck.",
      { modal: true },
    );
    return;
  }

  // Only now, with nothing able to press, is it worth waiting on the server.
  let report: StopReport | null = null;
  let serverError: string | null = null;
  try {
    report = (await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "Stopping Deck automation…" },
      () => callMcpTool("deck_stopAutomation", { by, reason: "stopped from the editor" }),
    )) as StopReport;
  } catch (err) {
    serverError = (err as Error).message;
  }

  if (serverError) {
    // Honest partial success. The dangerous half is done; say which half is not,
    // and say what covers the gap, because the firmware watchdog genuinely does.
    void vscode.window.showWarningMessage(
      `Deck automation is LATCHED OFF — no Studio process can press a button. ` +
        `But the Studio server could not be reached (${serverError}), so the board was not ` +
        `told to release and the SSH tunnels were not torn down. The board goes neutral by ` +
        `itself 750 ms after the link falls silent, which the latch guarantees.`,
      "Show Server Log",
    ).then((pick) => {
      if (pick) void vscode.commands.executeCommand("decky.showMcpOutput");
    });
    return;
  }

  const tunnels = report?.tunnels;
  const bits = [
    "Deck automation STOPPED and latched off.",
    report?.release?.ok
      ? "Board released."
      : report?.release?.attempted === false
        ? "Release skipped (this process was not driving the board)."
        : "Board release NOT confirmed — the firmware neutralises it after 750 ms of silence.",
    tunnels?.closed
      ? `Tunnels closed: ${tunnels.byKind?.cdp ?? 0} CDP, ${tunnels.byKind?.ingest ?? 0} ingest.`
      : "No live tunnels were registered.",
    tunnels?.failed ? `${tunnels.failed} tunnel(s) could NOT be closed.` : null,
    already ? "(It was already stopped.)" : null,
  ].filter(Boolean);

  void vscode.window.showWarningMessage(bits.join(" "), "Re-arm");
}

/**
 * Clear the latch. Human-only, by construction.
 *
 * This travels over the extension's own JSON-RPC dialect (`control/...`), which
 * the MCP surface has no route to -- there is no arming tool, and adding one
 * would undo the feature. An agent that can clear its own killswitch does not
 * have one.
 *
 * The confirmation is modal and repeats why it was stopped. Re-arming after a
 * stop somebody else set, without reading their reason, is how a stop that
 * meant "the ring is on Play, do not touch this" becomes a launched game.
 */
export async function armAutomation(): Promise<void> {
  const latch = readLatch();
  if (!latch) {
    void vscode.window.showInformationMessage("Deck automation is already armed.");
    return;
  }

  const detail =
    `Stopped at ${latch.at} by ${latch.by}.` +
    (latch.reason ? `\n\nReason: ${latch.reason}` : "") +
    "\n\nRe-arming permits every Studio process to press buttons on the Deck again. " +
    "It does not press anything by itself.";

  const choice = await vscode.window.showWarningMessage(
    "Re-arm Deck automation?",
    { modal: true, detail },
    "Re-arm",
  );
  if (choice !== "Re-arm") return;

  try {
    const result = (await callMcpControl("armAutomation", {})) as { summary?: string };
    void vscode.window.showInformationMessage(
      result?.summary ?? "Deck automation re-armed.",
    );
  } catch {
    // The server being down must not trap someone in a stopped state. Clearing
    // the file is the whole of arming -- the server call is only there so the
    // one implementation lives in one place.
    if (clearLatch()) {
      void vscode.window.showInformationMessage(
        "Deck automation re-armed (the Studio server was not reachable, so the latch was cleared directly).",
      );
    } else {
      void vscode.window.showErrorMessage(
        "Could not clear the killswitch latch. Delete it by hand to re-arm: " +
          "~/.config/decky-plugin-studio/automation-stop.json",
      );
    }
  }
}

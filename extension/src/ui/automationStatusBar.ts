import * as vscode from "vscode";
import { readLatch, countLiveTunnels, watchAutomation } from "../automation/latch";

/**
 * The killswitch's own status bar item, and the armed indicator.
 *
 * A SECOND ITEM, not a fourth dot on the existing one. Two reasons, both
 * learned the hard way on 2026-08-26. The first is that VS Code silently drops
 * right-aligned items that do not fit, so the existing item's text was cut down
 * to `$(play) Decky ●●●` with everything else moved into the tooltip -- and a
 * killswitch you have to hover to find is not a killswitch. It needs its own
 * text, its own colour, and its own click. The second is that its click has to
 * mean "stop", and the existing item's click means "open the preview"; one
 * item cannot have two.
 *
 * It sits at priority 1000, well left of the Studio item's 100, so it is the
 * last thing to be dropped when the bar gets crowded.
 *
 * IT IS ONLY LOUD WHEN LOUD IS USEFUL. A warning background that is always on
 * is a warning background nobody sees. Three states:
 *
 *   STOPPED -- error background. You need to know this: while it is set every
 *   Deck tool refuses, and without the indicator that reads as a broken bridge.
 *   This is the state most likely to waste an hour if it is not shown.
 *
 *   ARMED AND DRIVING -- warning background. A registered CDP forward means
 *   some process has a live path to the Deck right now, which is the closest
 *   honest signal available for "a run is happening". This is the moment the
 *   button exists for.
 *
 *   ARMED AND IDLE -- plain. The rig can press, nothing is pressing.
 */
export class AutomationStatusBar {
  private item: vscode.StatusBarItem;
  private watcher: { dispose: () => void };

  constructor() {
    this.item = vscode.window.createStatusBarItem(
      "deckyPluginStudio.automation",
      vscode.StatusBarAlignment.Right,
      1000,
    );
    // An id and a name so that hiding it once is not permanent: without them
    // there is no findable entry in the status bar's right-click Manage menu.
    this.item.name = "Decky Deck Automation";
    this.item.show();
    this.refresh();

    // The stop usually comes from another process -- the agent's own server, or
    // the CLI script -- so polling the server every 30s would leave the
    // indicator wrong for up to half a minute after a stop it did not make.
    this.watcher = watchAutomation(() => this.refresh());
  }

  refresh(): void {
    const latch = readLatch();

    if (latch) {
      this.item.text = "$(circle-slash) Deck STOPPED";
      this.item.command = "decky.armAutomation";
      this.item.backgroundColor = new vscode.ThemeColor("statusBarItem.errorBackground");
      this.item.tooltip = new vscode.MarkdownString(
        [
          "**Deck automation is STOPPED**",
          "",
          "No press will be delivered by any Studio process until you re-arm.",
          "",
          `| Stopped | ${latch.at} |`,
          "|---|---|",
          `| By | ${latch.by} |`,
          ...(latch.reason ? [`| Reason | ${latch.reason} |`] : []),
          "",
          "Click to re-arm.",
        ].join("\n"),
      );
      this.item.show();
      return;
    }

    const tunnels = countLiveTunnels();
    const driving = tunnels.cdp > 0;

    this.item.command = "decky.stopAutomation";
    this.item.backgroundColor = driving
      ? new vscode.ThemeColor("statusBarItem.warningBackground")
      : undefined;
    this.item.text = driving ? "$(debug-stop) STOP Deck" : "$(zap) Deck armed";
    this.item.tooltip = new vscode.MarkdownString(
      [
        driving ? "**Deck automation is running**" : "**Deck automation is armed**",
        "",
        driving
          ? "A Studio process has a live path to the Deck and can press buttons right now."
          : "The rig can press buttons. Nothing is driving the Deck at this moment.",
        "",
        `| Live CDP forwards | ${tunnels.cdp} |`,
        "|---|---|",
        `| Ingest tunnels | ${tunnels.ingest} |`,
        "",
        "Click to stop everything (`ctrl+alt+.`): release every held button,",
        "abort any run in flight, tear down the tunnels, and latch it off",
        "until you re-arm.",
      ].join("\n"),
    );
    this.item.show();
  }

  dispose(): void {
    this.watcher.dispose();
    this.item.dispose();
  }
}

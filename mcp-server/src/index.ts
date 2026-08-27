#!/usr/bin/env node
import readline from "readline";
import {
  startIngestServer,
  stopIngestServer,
  getIngestCount,
  tailIngest,
  probeIngest,
  getIngestPort,
} from "./ingest/server.js";
import { writeDeckEnv, getWorkspaceRoot } from "./config.js";
import * as deck from "./tools/deck.js";
import * as plugin from "./tools/plugin.js";
import * as preview from "./tools/preview.js";
import * as deckAutonomy from "./tools/deckAutonomy.js";
import { diffRpc } from "./preview/rpcDiff.js";
import { lintFocus } from "./lint/index.js";
import { readFocus } from "./deck/readFocus.js";
import { pressButton } from "./deck/pressButton.js";
import { assertFocusMove } from "./deck/assertFocusMove.js";
import { runSequence, SequenceStep } from "./deck/runSequence.js";
import { openPluginDriven } from "./deck/openPlugin.js";
import { walkTo, WalkDirection } from "./deck/walkTo.js";
import { readPage, waitFor } from "./deck/readPage.js";
import {
  stopAutomation,
  armAutomation,
  automationStatus,
  StopSource,
} from "./deck/killswitch.js";
import { TOOLS, TOOL_NAMES } from "./toolRegistry.js";

const MCP_PROTOCOL_VERSION = "2024-11-05";
const SERVER_INFO = { name: "decky-plugin-studio", version: "0.3.8" };

startIngestServer(Number(process.env.DEBUG_INGEST_PORT ?? 7682));

const rl = readline.createInterface({ input: process.stdin, terminal: false });

function respond(id: number | undefined, result: unknown, error?: { message: string }) {
  const msg = error
    ? { jsonrpc: "2.0", id, error: { code: -1, message: error.message } }
    : { jsonrpc: "2.0", id, result };
  process.stdout.write(JSON.stringify(msg) + "\n");
}

async function handle(method: string, params: Record<string, unknown>): Promise<unknown> {
  switch (method) {
    case "initialize":
      return { ok: true, workspaceRoot: getWorkspaceRoot() };

    case "tools/deck_configure":
      writeDeckEnv(params as Record<string, string>);
      return { ok: true };

    case "tools/deck_status": {
      const tunnel = deck.getTunnelState();
      const automation = automationStatus();
      const bridge = await deckAutonomy.probeBridge();
      return {
        tunnelRunning: tunnel.running,
        tunnelPid: tunnel.pid,
        ingestCount: getIngestCount(),
        ingestPort: getIngestPort(),
        deckReachable: await deck.pingDeck(),
        ollamaReachable: await deck.probeOllama(),
        // Carried here so anything already polling status learns the rig is
        // armed without a second round trip. The extension's indicator does not
        // depend on this -- it reads the latch file directly, because a dead
        // server must not be able to make a stopped rig look armed.
        automationArmed: automation.armed,
        automationStoppedSince: automation.stoppedSince,
        automationStoppedBy: automation.stoppedBy,
        bridgeReady: bridge.bridgeReady,
        bridgePort: bridge.port,
        bridgeReason: bridge.reason,
      };
    }

    case "tools/deck_stopAutomation":
      return stopAutomation({
        by: (params.by as StopSource) ?? "tool",
        reason: params.reason != null ? String(params.reason) : undefined,
        port: params.port != null ? String(params.port) : undefined,
      });

    case "tools/deck_automationStatus":
      return automationStatus();

    /*
     * Re-arming is NOT a tool, and the name is not `tools/...` for a reason.
     *
     * handleMcp() routes `tools/call` only through TOOL_NAMES and has no case
     * of its own for anything else, so once a peer speaks MCP this method is
     * unreachable -- it does not appear in tools/list and calling it by name
     * throws "Unknown method". Only the extension's dialect, which is what a
     * human's status bar click travels over, can get here.
     *
     * That is the whole point. An agent that hits the killswitch and can clear
     * it will clear it and carry on, and then there was never a killswitch.
     */
    case "control/armAutomation":
      return armAutomation();

    case "control/automationStatus":
      return automationStatus();

    case "tools/deck_startTunnel":
      return deck.startTunnel();

    case "tools/deck_stopTunnel":
      return deck.stopTunnel();

    case "tools/deck_probeIngest":
      return probeIngest();

    case "tools/deck_tailIngest":
      return tailIngest(params as { since?: number; lines?: number; hypothesisId?: string });

    case "tools/deck_captureScreenshot":
      return deck.captureScreenshot(
        String(params.mode ?? "auto"),
        Boolean(params.allowNonPluginUi)
      );

    case "tools/deck_installCaptureHelper":
      return deck.installCaptureHelper(
        (params.which as "record" | "capture" | "both") ?? "both"
      );

    case "tools/deck_deploy":
      return plugin.deployPlugin((params.mode as "auto" | "local" | "remote") ?? "auto");

    case "tools/deck_reloadPlugin":
      return deckAutonomy.reloadPlugin((params.mode as "auto" | "local" | "remote") ?? "auto");

    case "tools/deck_openPlugin": {
      // `drive: false` keeps the old checklist-only behaviour for anyone who
      // wants the steps without the board plugged in.
      if (params.drive === false) return deckAutonomy.openPlugin();
      const info = deckAutonomy.openPlugin();
      return openPluginDriven({
        pluginName: params.pluginName != null ? String(params.pluginName) : info.pluginName,
        port: params.port != null ? String(params.port) : undefined,
        cdpUrl: params.cdpUrl != null ? String(params.cdpUrl) : undefined,
        tabBudget: params.tabBudget != null ? Number(params.tabBudget) : undefined,
        listBudget: params.listBudget != null ? Number(params.listBudget) : undefined,
      });
    }

    case "tools/deck_readPage":
      return readPage({
        expression: String(params.expression ?? ""),
        target: params.target != null ? String(params.target) : undefined,
        cdpUrl: params.cdpUrl != null ? String(params.cdpUrl) : undefined,
        timeoutMs: params.timeoutMs != null ? Number(params.timeoutMs) : undefined,
      });

    case "tools/deck_waitFor":
      return waitFor({
        expression: String(params.expression ?? ""),
        equals: Object.prototype.hasOwnProperty.call(params, "equals") ? params.equals : undefined,
        waitMs: params.waitMs != null ? Number(params.waitMs) : undefined,
        intervalMs: params.intervalMs != null ? Number(params.intervalMs) : undefined,
        target: params.target != null ? String(params.target) : undefined,
        cdpUrl: params.cdpUrl != null ? String(params.cdpUrl) : undefined,
      });

    case "tools/deck_walkTo":
      return walkTo({
        direction: String(params.direction ?? "DOWN").toUpperCase() as WalkDirection,
        text: String(params.text ?? ""),
        budget: params.budget != null ? Number(params.budget) : undefined,
        exact: params.exact != null ? Boolean(params.exact) : undefined,
        stallLimit: params.stallLimit != null ? Number(params.stallLimit) : undefined,
        acquireFocus: params.acquireFocus != null ? Boolean(params.acquireFocus) : undefined,
        port: params.port != null ? String(params.port) : undefined,
        cdpUrl: params.cdpUrl != null ? String(params.cdpUrl) : undefined,
      });

    case "tools/deck_runSequence":
      return runSequence({
        steps: (params.steps as SequenceStep[]) ?? [],
        stopOnFailure: params.stopOnFailure != null ? Boolean(params.stopOnFailure) : undefined,
        mustReachText: (params.mustReachText as string[]) ?? undefined,
        port: params.port != null ? String(params.port) : undefined,
        cdpUrl: params.cdpUrl != null ? String(params.cdpUrl) : undefined,
        runName: params.runName != null ? String(params.runName) : undefined,
        writeEvidence: params.writeEvidence != null ? Boolean(params.writeEvidence) : undefined,
        acquireFocus: params.acquireFocus != null ? Boolean(params.acquireFocus) : undefined,
      });

    case "tools/deck_pressButton":
      return pressButton({
        buttons: (params.buttons as string[]) ?? [],
        holdMs: params.holdMs != null ? Number(params.holdMs) : undefined,
        port: params.port != null ? String(params.port) : undefined,
      });

    case "tools/deck_assertFocusMove":
      return assertFocusMove({
        press: (params.press as string | string[]) ?? [],
        expect: params.expect != null ? String(params.expect) : undefined,
        holdMs: params.holdMs != null ? Number(params.holdMs) : undefined,
        port: params.port != null ? String(params.port) : undefined,
        cdpUrl: params.cdpUrl != null ? String(params.cdpUrl) : undefined,
        settleTimeoutMs:
          params.settleTimeoutMs != null ? Number(params.settleTimeoutMs) : undefined,
      });

    case "tools/deck_readFocus":
      return readFocus({
        cdpUrl: params.cdpUrl != null ? String(params.cdpUrl) : undefined,
      });

    case "tools/deck_readPluginLog":
      return deckAutonomy.readPluginLog(
        Number(params.lines ?? 50),
        params.filter != null ? String(params.filter) : undefined
      );

    case "tools/deck_getEnv":
      return deckAutonomy.getEnv();

    case "tools/plugin_diffRpc":
      return diffRpc();

    case "tools/plugin_lintFocus":
      return lintFocus(params.pluginRoot != null ? String(params.pluginRoot) : undefined);

    case "tools/plugin_detect":
      return plugin.detectPlugin();

    case "tools/plugin_build":
      return plugin.buildPlugin();

    case "tools/plugin_verifyZip":
      return plugin.verifyZip();

    case "tools/preview_start":
      return preview.previewStart();

    case "tools/preview_stop":
      return preview.previewStop();

    case "tools/preview_status":
      return preview.previewStatus();

    case "tools/preview_injectFocusEvent":
      return preview.previewInjectFocusEvent(String(params.direction));

    case "tools/preview_callRpc":
      return preview.previewCallRpc(
        String(params.method),
        (params.args as unknown[]) ?? [],
        Number(params.collectEmitsMs ?? 0)
      );

    case "tools/preview_tailEmit":
      return preview.previewTailEmit({
        since: params.since != null ? Number(params.since) : undefined,
        lines: params.lines != null ? Number(params.lines) : undefined,
        event: params.event != null ? String(params.event) : undefined,
      });

    case "tools/preview_compareScreenshot":
      return preview.previewCompareScreenshot({
        name: String(params.name),
        selector: params.selector != null ? String(params.selector) : undefined,
        threshold: params.threshold != null ? Number(params.threshold) : undefined,
        updateBaseline: Boolean(params.updateBaseline),
      });

    case "tools/preview_readLog":
      return preview.previewReadLog(Number(params.lines ?? 50));

    case "tools/preview_setHardware":
      return preview.previewSetHardware(params as Record<string, unknown>);

    case "tools/preview_runSequence":
      return preview.previewRunSequence(
        params as {
          inputs: string[];
          delayMs?: number;
          hwOverrides?: Record<string, unknown>;
          snapshot?: "dom" | "screenshot" | "both";
        }
      );

    case "tools/preview_snapshotDom":
      return preview.previewSnapshotDom(
        params as { selector?: string; attrs?: string[]; text?: string }
      );

    case "tools/preview_captureScreenshot":
      return preview.previewCaptureScreenshot(params as { selector?: string });

    case "tools/preview_setHttpAllow":
      return preview.previewSetHttpAllow(String(params.allowlist ?? ""));

    case "tools/preview_health":
      return preview.previewHealth();

    case "tools/preview_callTestHook":
      return preview.previewCallTestHook(
        String(params.method),
        (params.args as unknown[]) ?? []
      );

    case "tools/preview_setPermissions":
      return preview.previewSetPermissions(
        (params.permissions as Record<string, boolean>) ?? {}
      );

    case "tools/deck_record":
      return deck.recordDeck(
        String(params.seconds ?? "10"),
        String(params.mode ?? "auto"),
        String(params.quality ?? "compressed"),
        Boolean(params.allowNonPluginUi)
      );

    case "shutdown":
      stopIngestServer();
      process.exit(0);

    default:
      throw new Error(`Unknown method: ${method}`);
  }
}

/**
 * Real MCP protocol surface.
 *
 * Implemented directly on the shared stdio stream rather than via the SDK's
 * StdioServerTransport: that transport takes exclusive ownership of stdin, and
 * this process must keep serving the extension's own JSON-RPC dialect on the
 * same pipe. Two readers on one stdin is not possible, so the framing is
 * hand-rolled and the dispatch below stays the single implementation.
 */
async function handleMcp(method: string, params: Record<string, unknown>): Promise<unknown> {
  switch (method) {
    case "initialize":
      return {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
      };

    case "ping":
      return {};

    // Notifications: acknowledged by doing nothing. The previous implementation
    // answered these with an "Unknown method" error, which is a JSON-RPC
    // violation and failed the handshake for strict clients.
    case "notifications/initialized":
    case "notifications/cancelled":
      return undefined;

    case "tools/list":
      return { tools: TOOLS };

    case "tools/call": {
      const name = String(params.name ?? "");
      const args = (params.arguments as Record<string, unknown>) ?? {};
      if (!TOOL_NAMES.has(name)) {
        throw new Error(`Unknown tool: ${name}`);
      }
      try {
        const result = await handle(`tools/${name}`, args);
        return {
          content: [{ type: "text", text: JSON.stringify(result ?? null, null, 2) }],
        };
      } catch (err) {
        // Tool failures go back as content with isError, per MCP convention, so
        // the calling model can read and react to them. A protocol-level error
        // would be invisible to it.
        return { content: [{ type: "text", text: String(err) }], isError: true };
      }
    }

    default:
      throw new Error(`Unknown method: ${method}`);
  }
}

/**
 * Which dialect the peer speaks. A real MCP client sends `protocolVersion` on
 * initialize; the VS Code extension's client (extension/src/mcp/client.ts)
 * sends `workspaceRoot`. One process serves both so the extension keeps working
 * unchanged while external agents get a discoverable tool list.
 */
let mcpMode = false;

rl.on("line", async (line) => {
  if (!line.trim()) return;

  let msg: { id?: number | string | null; method?: string; params?: Record<string, unknown> };
  try {
    msg = JSON.parse(line);
  } catch {
    return; // not JSON — ignore rather than emitting an unsolicited error frame
  }
  if (typeof msg.method !== "string") return; // a response, not a request

  const params = msg.params ?? {};
  if (msg.method === "initialize" && typeof params.protocolVersion === "string") {
    mcpMode = true;
  }

  // A JSON-RPC notification has no id and must never receive a response.
  const isNotification = msg.id === undefined || msg.id === null;

  try {
    const result = mcpMode
      ? await handleMcp(msg.method, params)
      : await handle(msg.method, params);
    if (!isNotification) respond(msg.id as number, result);
  } catch (err) {
    if (!isNotification) respond(msg.id as number, null, { message: String(err) });
  }
});

// MCP clients shut the server down by closing stdin rather than calling a
// shutdown method.
rl.on("close", () => {
  stopIngestServer();
  process.exit(0);
});

process.on("SIGINT", () => {
  stopIngestServer();
  process.exit(0);
});

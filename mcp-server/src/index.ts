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
      return {
        tunnelRunning: tunnel.running,
        tunnelPid: tunnel.pid,
        ingestCount: getIngestCount(),
        ingestPort: getIngestPort(),
        deckReachable: await deck.pingDeck(),
        ollamaReachable: await deck.probeOllama(),
      };
    }

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
      return preview.previewCallRpc(String(params.method), (params.args as unknown[]) ?? []);

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

rl.on("line", async (line) => {
  if (!line.trim()) return;
  try {
    const msg = JSON.parse(line) as { id?: number; method: string; params?: Record<string, unknown> };
    const result = await handle(msg.method, msg.params ?? {});
    respond(msg.id, result);
  } catch (err) {
    respond(undefined, null, { message: String(err) });
  }
});

process.on("SIGINT", () => {
  stopIngestServer();
  process.exit(0);
});

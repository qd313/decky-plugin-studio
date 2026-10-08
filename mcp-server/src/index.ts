#!/usr/bin/env node
import readline from "readline";
import path from "path";
import {
  startIngestServer,
  stopIngestServer,
  getIngestCount,
  tailIngest,
  probeIngest,
  getIngestPort,
} from "./ingest/server.js";
import { writeDeckEnv, getWorkspaceRoot, getDeckEnvPath } from "./config.js";
import {
  currentMachine,
  defaultMachineName,
  DEFAULT_MACHINE_NAME,
  getMachinesPath,
  labelOf,
  listMachines,
  Machine,
  MachineKind,
  resolveMachine,
  runWithMachine,
  upsertMachine,
} from "./machines.js";
import {
  leaseHeldByOther,
  listLeases,
  readLease,
  releaseLease,
  releaseLeasesHeldByThisProcess,
  withLease,
} from "./deck/lease.js";
import * as deck from "./tools/deck.js";
import * as plugin from "./tools/plugin.js";
import * as preview from "./tools/preview.js";
import * as deckAutonomy from "./tools/deckAutonomy.js";
import { diffRpc } from "./preview/rpcDiff.js";
import { lintFocus } from "./lint/index.js";
import { readFocus } from "./deck/readFocus.js";
import { pressButton, pressChord } from "./deck/pressButton.js";
import { launchGame, exitGame } from "./deck/gameSession.js";
import { assertFocusMove } from "./deck/assertFocusMove.js";
import { runSequence, SequenceStep } from "./deck/runSequence.js";
import { openPluginDriven } from "./deck/openPlugin.js";
import { walkTo, WalkDirection } from "./deck/walkTo.js";
import { sweep, LaneButton } from "./deck/sweep.js";
import { readPage, waitFor } from "./deck/readPage.js";
import { closeSharedCdpTunnel, padEndpointIfOpen } from "./deck/cdpTunnel.js";
import { saveCheck, replayChecks } from "./checks/checkRunner.js";
import { checkDeckReady, DeclaredState } from "./deck/checkReady.js";
import { holdAwake, restorePowerSettings } from "./deck/holdAwake.js";
import { snapshotSettings, restoreSettings } from "./deck/settingsSnapshot.js";
import { loadPreviewConfig } from "./preview/previewConfig.js";
import {
  stopAutomation,
  armAutomation,
  automationStatus,
  StopSource,
} from "./deck/killswitch.js";
import { TOOLS, TOOL_NAMES } from "./toolRegistry.js";
import { buildToolCallContent, buildToolErrorContent } from "./toolContent.js";

const MCP_PROTOCOL_VERSION = "2024-11-05";
const SERVER_INFO = { name: "decky-plugin-studio", version: "0.3.11" };

startIngestServer(Number(process.env.DEBUG_INGEST_PORT ?? 7682));

const rl = readline.createInterface({ input: process.stdin, terminal: false });

function respond(id: number | undefined, result: unknown, error?: { message: string }) {
  const msg = error
    ? { jsonrpc: "2.0", id, error: { code: -1, message: error.message } }
    : { jsonrpc: "2.0", id, result };
  process.stdout.write(JSON.stringify(msg) + "\n");
}

/**
 * Tools that DRIVE a machine -- press, deploy, reload, hold it awake, swap
 * its settings, record it -- and therefore need its lease (deck/lease.ts).
 * Reads, the killswitch, the restore tools and the registry tools do not:
 * a second session must always be able to look, stop, and put things back.
 */
const DRIVING_TOOLS: ReadonlySet<string> = new Set([
  "deck_pressButton",
  "deck_pressChord",
  "deck_walkTo",
  "deck_runSequence",
  "deck_sweep",
  "deck_openPlugin",
  "deck_launchGame",
  "deck_exitGame",
  "deck_assertFocusMove",
  "deck_saveCheck",
  "deck_replayChecks",
  "deck_deploy",
  "deck_reloadPlugin",
  "deck_holdAwake",
  "deck_snapshotSettings",
  "deck_record",
  "deck_captureScreenshot",
  "deck_installCaptureHelper",
]);

/**
 * Tools about the registry or the killswitch. They take a machine NAME, not
 * a resolved machine, and must keep working when that name does not resolve
 * (a machine being added, a broken machines.json during a stop).
 */
const REGISTRY_TOOLS: ReadonlySet<string> = new Set([
  "deck_configure",
  "deck_listMachines",
  "deck_releaseMachine",
  "deck_stopAutomation",
  "deck_automationStatus",
]);

/**
 * THE DISPATCH SEAM (plan 10 § 5). Every deck_* call resolves its `machine`
 * argument here, once, and runs inside that machine's context; the tools
 * below ask machines.ts `currentMachine()` and never read deck.env or a
 * `machine` argument of their own. Driving tools also take the machine's
 * lease here, so "only one driver at a time" is enforced in one place. And
 * every result is stamped `machine: { name, kind, os }`, so a stand-in's
 * verdict can never be filed as the Deck's.
 */
async function handle(method: string, params: Record<string, unknown>): Promise<unknown> {
  if (!method.startsWith("tools/deck_")) return dispatch(method, params);
  const tool = method.slice("tools/".length);
  if (REGISTRY_TOOLS.has(tool)) return dispatch(method, params);

  const { machine: machineArg, ...rest } = params;
  const machine = resolveMachine(machineArg != null ? String(machineArg) : undefined);
  const result = await runWithMachine(machine, () =>
    DRIVING_TOOLS.has(tool)
      ? withLease(machine.name, tool, () => dispatch(method, rest))
      : dispatch(method, rest),
  );
  return labelResult(result, machine);
}

function labelResult(result: unknown, machine: Machine): unknown {
  // Assigned onto the same object, not spread into a new one, so a picture
  // attached by withImage() (a non-enumerable symbol) survives the stamp.
  if (result && typeof result === "object" && !Array.isArray(result)) {
    (result as Record<string, unknown>).machine = labelOf(machine);
  }
  return result;
}

/** Fields of a machine entry deck_configure accepts; everything else it is handed is deck.env's. */
const MACHINE_FIELDS = ["kind", "os", "local", "host", "user", "press", "bridgePort", "padPort", "cdpPort", "pluginsDir", "vm", "note"] as const;

async function dispatch(method: string, params: Record<string, unknown>): Promise<unknown> {
  switch (method) {
    case "initialize":
      return { ok: true, workspaceRoot: getWorkspaceRoot() };

    case "tools/deck_configure": {
      const machineName = params.machine != null ? String(params.machine).trim() : "";
      if (!machineName) {
        // The call bonsAI has always made: KEY=VALUE pairs into deck.env.
        writeDeckEnv(params as Record<string, string>);
        return { ok: true, path: getDeckEnvPath() };
      }
      // A registry entry (plan 10): add, extend or remove a machine.
      const { machine: _machine, remove, makeDefault, ...fields } = params;
      const entry: Record<string, unknown> = {};
      for (const k of MACHINE_FIELDS) if (k in fields) entry[k] = fields[k];
      const deckKeys = Object.keys(fields).filter((k) => k.startsWith("DECK_"));
      if (machineName === DEFAULT_MACHINE_NAME && deckKeys.length) {
        writeDeckEnv(Object.fromEntries(deckKeys.map((k) => [k, String(fields[k])])));
      }
      const r = upsertMachine(machineName, entry as Partial<Machine>, {
        remove: Boolean(remove),
        makeDefault: Boolean(makeDefault),
      });
      return { ok: true, machine: r.machine, path: r.path, removed: Boolean(remove), default: defaultMachineName() };
    }

    case "tools/deck_listMachines": {
      const machines = listMachines();
      const leases = listLeases();
      const automation = automationStatus();
      return {
        default: defaultMachineName(),
        path: getMachinesPath(),
        allStopped: !automation.armed,
        machines: machines.map((m) => {
          const lease = leases.find((l) => l.machine === m.name && l.live) ?? null;
          const stopped = automation.machinesStopped.find((s) => s.machine === m.name) ?? null;
          return {
            ...m,
            lease: lease
              ? { owner: lease.owner, purpose: lease.purpose, since: lease.since, expiresAt: lease.expiresAt, mine: lease.mine }
              : null,
            stopped,
          };
        }),
      };
    }

    case "tools/deck_releaseMachine": {
      const name = params.machine != null ? String(params.machine).trim() : defaultMachineName();
      return { machine: name, ...releaseLease(name, { force: Boolean(params.force) }) };
    }

    case "tools/deck_status": {
      const m = currentMachine();
      const tunnel = deck.getTunnelState();
      const automation = automationStatus();
      const heldByOther = leaseHeldByOther(m.name);
      const lease = readLease(m.name);

      // The status poll stays off a serial port another session is driving
      // through (ROADMAP: "status poll opens COM7"); a virtual pad is a TCP
      // socket that takes any number of clients, so it is always probed.
      let bridge: { bridgePortOpen: boolean; bridgeReady: boolean; port: string; reason?: string; probed: boolean };
      let virtualPad: deckAutonomy.VirtualPadProbe | null = null;
      if (m.press === "bridge") {
        bridge = heldByOther
          ? {
              bridgePortOpen: false,
              bridgeReady: false,
              port: deckAutonomy.getConfiguredBridgePort(),
              probed: false,
              reason: `not probed: "${m.name}" is leased by ${heldByOther.owner} (${heldByOther.purpose}); the status poll stays off a leased serial port`,
            }
          : { ...(await deckAutonomy.probeBridge()), probed: true };
      } else {
        bridge = {
          bridgePortOpen: false,
          bridgeReady: false,
          port: "",
          probed: false,
          reason: `machine "${m.name}" presses through ${m.press === "none" ? "nothing (press: none)" : `a virtual pad (${m.press})`}, not the bridge board`,
        };
        if (m.press === "uinput" || m.press === "vigem") virtualPad = await deckAutonomy.probeVirtualPad(m);
      }

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
        automationArmed: automation.armed && !automation.machinesStopped.some((s) => s.machine === m.name),
        automationStoppedSince: automation.stoppedSince,
        automationStoppedBy: automation.stoppedBy,
        machineStopped: automation.machinesStopped.find((s) => s.machine === m.name) ?? null,
        bridgePortOpen: bridge.bridgePortOpen,
        // Deprecated: use bridgePortOpen. Same value, kept so an existing
        // consumer (bonsAI) reading this name does not break on the rename.
        bridgeReady: bridge.bridgeReady,
        bridgePort: bridge.port,
        bridgeReason: bridge.reason,
        bridgeProbed: bridge.probed,
        virtualPad,
        lease: lease
          ? {
              owner: lease.owner,
              purpose: lease.purpose,
              since: lease.since,
              expiresAt: lease.expiresAt,
              mine: lease.ownerPid === process.pid,
              heldByOther: Boolean(heldByOther),
            }
          : null,
      };
    }

    case "tools/deck_stopAutomation":
      return stopAutomation({
        by: (params.by as StopSource) ?? "tool",
        reason: params.reason != null ? String(params.reason) : undefined,
        port: params.port != null ? String(params.port) : undefined,
        machine: params.machine != null ? String(params.machine) : undefined,
        padEndpointIfOpen,
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
      return plugin.deployPlugin((params.mode as "auto" | "local" | "remote") ?? "auto", {
        waitForLoader: params.waitForLoader !== false,
        loaderTimeoutMs: params.loaderTimeoutMs != null ? Number(params.loaderTimeoutMs) : undefined,
      });

    case "tools/deck_reloadPlugin":
      return deckAutonomy.reloadPlugin((params.mode as "auto" | "local" | "remote") ?? "auto", {
        waitForLoader: params.waitForLoader !== false,
        loaderTimeoutMs: params.loaderTimeoutMs != null ? Number(params.loaderTimeoutMs) : undefined,
      });

    case "tools/deck_openPlugin": {
      // `drive: false` keeps the old checklist-only behaviour for anyone who
      // wants the steps without the board plugged in.
      if (params.drive === false) return deckAutonomy.openPlugin();
      const info = deckAutonomy.openPlugin();
      // The workspace's own selector is the default; an explicit argument wins.
      // Without either, already-open falls back to inferring from Decky's pane
      // labels, which is what reported an unmounted panel as open (P1-9).
      const configured = loadPreviewConfig().panelRootSelector;
      return openPluginDriven({
        pluginName: params.pluginName != null ? String(params.pluginName) : info.pluginName,
        port: params.port != null ? String(params.port) : undefined,
        cdpUrl: params.cdpUrl != null ? String(params.cdpUrl) : undefined,
        tabBudget: params.tabBudget != null ? Number(params.tabBudget) : undefined,
        listBudget: params.listBudget != null ? Number(params.listBudget) : undefined,
        rootSelector: params.rootSelector != null ? String(params.rootSelector) : configured,
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
        requireVisible: params.requireVisible != null ? Boolean(params.requireVisible) : undefined,
      });

    case "tools/deck_sweep":
      return sweep({
        direction:
          params.direction != null
            ? (String(params.direction).toUpperCase() as WalkDirection)
            : undefined,
        returnTrip: params.returnTrip != null ? Boolean(params.returnTrip) : undefined,
        lanes: params.lanes != null ? Number(params.lanes) : undefined,
        laneButton:
          params.laneButton != null
            ? (String(params.laneButton).toUpperCase() as LaneButton)
            : undefined,
        budget: params.budget != null ? Number(params.budget) : undefined,
        stallLimit: params.stallLimit != null ? Number(params.stallLimit) : undefined,
        acquireFocus: params.acquireFocus != null ? Boolean(params.acquireFocus) : undefined,
        port: params.port != null ? String(params.port) : undefined,
        cdpUrl: params.cdpUrl != null ? String(params.cdpUrl) : undefined,
        runName: params.runName != null ? String(params.runName) : undefined,
        writeEvidence: params.writeEvidence != null ? Boolean(params.writeEvidence) : undefined,
      });

    case "tools/deck_saveCheck": {
      const name = String(params.name ?? "");
      const tool = String(params.tool ?? "");
      const pluginRoot = params.pluginRoot != null ? String(params.pluginRoot) : getWorkspaceRoot();
      const checksDir = params.checksDir != null ? String(params.checksDir) : path.join(getWorkspaceRoot(), "checks");

      if (tool === "deck_sweep") {
        const s = (params.sweep as Record<string, unknown>) ?? {};
        return saveCheck({
          name,
          tool: "deck_sweep",
          checksDir,
          pluginRoot,
          sweepOptions: {
            direction: s.direction != null ? (String(s.direction).toUpperCase() as WalkDirection) : undefined,
            returnTrip: s.returnTrip != null ? Boolean(s.returnTrip) : undefined,
            lanes: s.lanes != null ? Number(s.lanes) : undefined,
            laneButton: s.laneButton != null ? (String(s.laneButton).toUpperCase() as LaneButton) : undefined,
            budget: s.budget != null ? Number(s.budget) : undefined,
            stallLimit: s.stallLimit != null ? Number(s.stallLimit) : undefined,
            acquireFocus: s.acquireFocus != null ? Boolean(s.acquireFocus) : undefined,
            port: s.port != null ? String(s.port) : undefined,
            cdpUrl: s.cdpUrl != null ? String(s.cdpUrl) : undefined,
          },
        });
      }
      if (tool === "deck_runSequence") {
        const seq = (params.sequence as Record<string, unknown>) ?? {};
        return saveCheck({
          name,
          tool: "deck_runSequence",
          checksDir,
          pluginRoot,
          sequenceOptions: {
            steps: (seq.steps as SequenceStep[]) ?? [],
            stopOnFailure: seq.stopOnFailure != null ? Boolean(seq.stopOnFailure) : undefined,
            mustReachText: (seq.mustReachText as string[]) ?? undefined,
            requireVisible: seq.requireVisible != null ? Boolean(seq.requireVisible) : undefined,
            acquireFocus: seq.acquireFocus != null ? Boolean(seq.acquireFocus) : undefined,
            port: seq.port != null ? String(seq.port) : undefined,
            cdpUrl: seq.cdpUrl != null ? String(seq.cdpUrl) : undefined,
          },
        });
      }
      throw new Error(`deck_saveCheck: "tool" must be "deck_sweep" or "deck_runSequence", got ${JSON.stringify(params.tool)}`);
    }

    case "tools/deck_replayChecks":
      return replayChecks({
        checksDir: params.checksDir != null ? String(params.checksDir) : path.join(getWorkspaceRoot(), "checks"),
        pluginRoot: params.pluginRoot != null ? String(params.pluginRoot) : getWorkspaceRoot(),
        only: (params.only as string[]) ?? undefined,
        port: params.port != null ? String(params.port) : undefined,
        cdpUrl: params.cdpUrl != null ? String(params.cdpUrl) : undefined,
      });

    case "tools/deck_pressButton":
      return pressButton({
        buttons: (params.buttons as string[]) ?? [],
        holdMs: params.holdMs != null ? Number(params.holdMs) : undefined,
        port: params.port != null ? String(params.port) : undefined,
        verify: params.verify != null ? Boolean(params.verify) : undefined,
        cdpUrl: params.cdpUrl != null ? String(params.cdpUrl) : undefined,
      });

    case "tools/deck_pressChord":
      return pressChord(String(params.hold ?? ""), String(params.tap ?? ""), {
        port: params.port != null ? String(params.port) : undefined,
      });

    case "tools/deck_launchGame":
      return launchGame({
        name: params.name != null ? String(params.name) : undefined,
        appid: params.appid != null ? Number(params.appid) : undefined,
        budget: params.budget != null ? Number(params.budget) : undefined,
        waitMs: params.waitMs != null ? Number(params.waitMs) : undefined,
        port: params.port != null ? String(params.port) : undefined,
        cdpUrl: params.cdpUrl != null ? String(params.cdpUrl) : undefined,
        runName: params.runName != null ? String(params.runName) : undefined,
        writeEvidence: params.writeEvidence != null ? Boolean(params.writeEvidence) : undefined,
      });

    case "tools/deck_exitGame":
      return exitGame({
        waitMs: params.waitMs != null ? Number(params.waitMs) : undefined,
        port: params.port != null ? String(params.port) : undefined,
        cdpUrl: params.cdpUrl != null ? String(params.cdpUrl) : undefined,
        runName: params.runName != null ? String(params.runName) : undefined,
        writeEvidence: params.writeEvidence != null ? Boolean(params.writeEvidence) : undefined,
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
        timeoutMs: params.timeoutMs != null ? Number(params.timeoutMs) : undefined,
      });

    case "tools/deck_checkReady": {
      const info = plugin.detectPlugin();
      const m = currentMachine();
      const configuredRootSelector = loadPreviewConfig().panelRootSelector;
      let defaultPluginName: string | undefined;
      try {
        defaultPluginName = info.valid ? plugin.remotePluginDirName(info.name) : undefined;
      } catch {
        // An invalid manifest name still lets every other declared check run;
        // buildMatches alone reports "missing pluginName" if it was asked for.
        defaultPluginName = undefined;
      }

      const declared: DeclaredState = {
        awake: params.awake != null ? Boolean(params.awake) : undefined,
        buildMatches: params.buildMatches != null ? Boolean(params.buildMatches) : undefined,
        runningAppId: Object.prototype.hasOwnProperty.call(params, "runningAppId")
          ? params.runningAppId === null
            ? null
            : Number(params.runningAppId)
          : undefined,
        pluginOpen: params.pluginOpen != null ? String(params.pluginOpen) : undefined,
        noForeignCdpTunnel: params.noForeignCdpTunnel != null ? Boolean(params.noForeignCdpTunnel) : undefined,
        modalOnScreen: params.modalOnScreen != null ? Boolean(params.modalOnScreen) : undefined,
        focusRingOwned: params.focusRingOwned != null ? Boolean(params.focusRingOwned) : undefined,
        machineKind: params.machineKind != null ? (String(params.machineKind) as MachineKind) : undefined,
      };

      return checkDeckReady(declared, {
        cdpUrl: params.cdpUrl != null ? String(params.cdpUrl) : undefined,
        targetsSettleMs: params.targetsSettleMs != null ? Number(params.targetsSettleMs) : undefined,
        timeoutMs: params.timeoutMs != null ? Number(params.timeoutMs) : undefined,
        rootSelector: params.rootSelector != null ? String(params.rootSelector) : configuredRootSelector,
        pluginRoot: params.pluginRoot != null ? String(params.pluginRoot) : info.valid ? info.root : undefined,
        pluginName: params.pluginName != null ? String(params.pluginName) : defaultPluginName,
        user: m.user ?? "deck",
        host: m.host,
        pingFn: deck.pingDeck,
      });
    }

    case "tools/deck_readPluginLog":
      return deckAutonomy.readPluginLog(
        Number(params.lines ?? 50),
        params.filter != null ? String(params.filter) : undefined
      );

    case "tools/deck_getEnv":
      return deckAutonomy.getEnv();

    case "tools/deck_holdAwake":
      return holdAwake({
        ttlMinutes: params.ttlMinutes != null ? Number(params.ttlMinutes) : undefined,
        note: params.note != null ? String(params.note) : undefined,
      });

    case "tools/deck_restorePowerSettings":
      return restorePowerSettings();

    case "tools/deck_snapshotSettings":
      return snapshotSettings({
        includeData: params.includeData != null ? Boolean(params.includeData) : undefined,
        ttlMinutes: params.ttlMinutes != null ? Number(params.ttlMinutes) : undefined,
        note: params.note != null ? String(params.note) : undefined,
      });

    case "tools/deck_restoreSettings":
      return restoreSettings();

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
      releaseLeasesHeldByThisProcess();
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
        // A tool that has a picture (deck_captureScreenshot,
        // preview_captureScreenshot) called withImage() on its return value;
        // buildToolCallContent() is the one place that knows to look for it,
        // so a picture-returning tool never needs a case of its own here.
        return { content: buildToolCallContent(result) };
      } catch (err) {
        // Tool failures go back as content with isError, per MCP convention, so
        // the calling model can read and react to them. A protocol-level error
        // would be invisible to it. Always one text block, never an image --
        // see buildToolErrorContent().
        return buildToolErrorContent(err);
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
// shutdown method. The shared CDP tunnel (cdpTunnel.ts) now outlives any
// single call, so it has to be released here explicitly -- unlike the old
// per-call tunnel, nothing else closes it on the way out.
rl.on("close", () => {
  stopIngestServer();
  closeSharedCdpTunnel();
  // A session that ends releases its machines (deck/lease.ts), so the next
  // session is not told to wait for a driver that no longer exists.
  releaseLeasesHeldByThisProcess();
  process.exit(0);
});

process.on("SIGINT", () => {
  stopIngestServer();
  closeSharedCdpTunnel();
  releaseLeasesHeldByThisProcess();
  process.exit(0);
});

/**
 * Tool metadata for MCP `tools/list`.
 *
 * Every entry here maps 1:1 onto a case in the dispatch switch in index.ts:
 * MCP tool `deck_deploy` is routed to the internal method `tools/deck_deploy`.
 * The dispatch remains the single implementation — this file only describes it.
 *
 * Descriptions are written for an agent deciding which tool to reach for, so
 * they say what the tool does AND when it is the wrong choice. A tool missing
 * from this file still works over the extension's dialect but is invisible to
 * every external agent — toolRegistry.test.ts diffs this list against the
 * dispatch cases so that drift fails the build rather than silently hiding a tool.
 */

export interface ToolDef {
  /** MCP tool name; internal method is `tools/${name}`. */
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  };
}

const noArgs = { type: "object" as const, properties: {}, additionalProperties: false };

const DEPLOY_MODE = {
  type: "string",
  enum: ["auto", "local", "remote"],
  default: "auto",
  description:
    "'local' targets a Decky Loader on this machine, 'remote' SSHes to the configured Deck IP, 'auto' picks based on configuration.",
};

const CAPTURE_MODE = {
  type: "string",
  enum: ["auto", "game", "desktop"],
  default: "auto",
  description:
    "'game' uses gamescope composition (captures QAM and overlays), 'desktop' captures the desktop session, 'auto' detects which is active.",
};

const ALLOW_NON_PLUGIN_UI = {
  type: "boolean",
  default: false,
  description:
    "Permit a capture that does not show plugin UI. Off by default so an accidental capture of the wrong screen fails loudly instead of silently becoming evidence.",
};

/** Focus directions the preview's focus manager understands. */
const DIRECTIONS = "Up, Down, Left, Right, A, B, X, Y, Select, Steam, QAM";

export const TOOLS: ToolDef[] = [
  // ---- Deck: configuration & status ------------------------------------
  {
    name: "deck_configure",
    description:
      "Persist Steam Deck connection settings (deck IP, user, SSH details) to the studio's deck.env. Call once before remote deploy or tunnel operations.",
    inputSchema: {
      type: "object",
      properties: {
        DECK_IP: { type: "string", description: "Steam Deck IP address on the LAN." },
        DECK_USER: { type: "string", default: "deck", description: "SSH user on the Deck." },
      },
      // Any further KEY=VALUE pairs are written to deck.env verbatim.
      additionalProperties: true,
    },
  },
  {
    name: "deck_status",
    description:
      "Snapshot of the whole dev environment: tunnel running, debug-ingest count and port, whether the Deck answers, whether Ollama is reachable. Cheap — call this first when diagnosing why something is not working.",
    inputSchema: noArgs,
  },
  {
    name: "deck_getEnv",
    description:
      "Read back the currently configured Deck environment (IP, user, paths) without modifying it.",
    inputSchema: noArgs,
  },

  // ---- Deck: tunnel & ingest -------------------------------------------
  {
    name: "deck_startTunnel",
    description:
      "Start the reverse SSH tunnel so the Deck can push debug logs back to this machine's ingest server. Required before deck_tailIngest returns on-device logs.",
    inputSchema: noArgs,
  },
  {
    name: "deck_stopTunnel",
    description: "Stop the reverse SSH tunnel started by deck_startTunnel.",
    inputSchema: noArgs,
  },
  {
    name: "deck_probeIngest",
    description:
      "Check the debug-ingest endpoint is up and reachable. Use to distinguish 'no logs because nothing logged' from 'no logs because ingest is down'.",
    inputSchema: noArgs,
  },
  {
    name: "deck_tailIngest",
    description:
      "Read debug events pushed from the Deck. Filter by hypothesisId to isolate one debugging thread.",
    inputSchema: {
      type: "object",
      properties: {
        since: { type: "number", description: "Only events with a timestamp after this epoch ms." },
        lines: { type: "number", description: "Maximum number of events to return." },
        hypothesisId: {
          type: "string",
          description: "Return only events tagged with this hypothesis id.",
        },
      },
      additionalProperties: false,
    },
  },

  // ---- Deck: capture ----------------------------------------------------
  {
    name: "deck_captureScreenshot",
    description:
      "Take a composited screenshot on the real Deck (QAM and Decky overlays included in game mode) and save it to the workspace screenshots directory. This is on-device capture — for the in-IDE preview use preview_captureScreenshot instead.",
    inputSchema: {
      type: "object",
      properties: { mode: CAPTURE_MODE, allowNonPluginUi: ALLOW_NON_PLUGIN_UI },
      additionalProperties: false,
    },
  },
  {
    name: "deck_record",
    description:
      "Record a composited screen video on the Deck. Prefer 'compressed' unless the artifact needs frame detail; 'full' produces very large files.",
    inputSchema: {
      type: "object",
      properties: {
        seconds: { type: "number", default: 10, description: "Recording duration in seconds." },
        mode: CAPTURE_MODE,
        quality: {
          type: "string",
          enum: ["compressed", "full"],
          default: "compressed",
          description: "'compressed' is VP8 at roughly 2.5 Mbps; 'full' is high-bitrate MJPEG/H.264.",
        },
        allowNonPluginUi: ALLOW_NON_PLUGIN_UI,
      },
      additionalProperties: false,
    },
  },
  {
    name: "deck_installCaptureHelper",
    description:
      "Install the capture/record helper scripts onto the Deck. Run once per device, or after upgrading the studio, before deck_captureScreenshot or deck_record.",
    inputSchema: {
      type: "object",
      properties: {
        which: {
          type: "string",
          enum: ["record", "capture", "both"],
          default: "both",
          description: "Which helper scripts to install.",
        },
      },
      additionalProperties: false,
    },
  },

  // ---- Deck: plugin lifecycle -------------------------------------------
  {
    name: "deck_deploy",
    description:
      "Build and install the current plugin onto Decky Loader, then restart the loader. The main deploy verb — use before on-device QA.",
    inputSchema: {
      type: "object",
      properties: { mode: DEPLOY_MODE },
      additionalProperties: false,
    },
  },
  {
    name: "deck_reloadPlugin",
    description:
      "Reload just this plugin without a full redeploy. Faster than deck_deploy when only backend Python changed and the bundle is already installed.",
    inputSchema: {
      type: "object",
      properties: { mode: DEPLOY_MODE },
      additionalProperties: false,
    },
  },
  {
    name: "deck_openPlugin",
    description:
      "Open the plugin in the Deck UI. NOTE: this does not automate Steam — it returns a manual checklist for a human to follow on the device.",
    inputSchema: noArgs,
  },
  {
    name: "deck_readPluginLog",
    description:
      "Read the plugin's log from the Deck. Use filter to grep server-side rather than pulling a large log and searching locally.",
    inputSchema: {
      type: "object",
      properties: {
        lines: { type: "number", default: 50, description: "Number of trailing lines to read." },
        filter: { type: "string", description: "Only return lines containing this substring." },
      },
      additionalProperties: false,
    },
  },

  // ---- Plugin: build & validation ---------------------------------------
  {
    name: "plugin_detect",
    description:
      "Identify the plugin in the current workspace: name, and whether it has plugin.json, main.py and a rollup config. Use to confirm the workspace is actually a Decky plugin before other calls.",
    inputSchema: noArgs,
  },
  {
    name: "plugin_build",
    description: "Build the plugin frontend bundle without deploying it.",
    inputSchema: noArgs,
  },
  {
    name: "plugin_verifyZip",
    description:
      "Validate the packaged plugin zip has the layout Decky Loader expects. Run before publishing a release.",
    inputSchema: noArgs,
  },
  {
    name: "plugin_diffRpc",
    description:
      "Report RPC parity between the frontend's call() sites and the methods main.py actually exposes. Catches renamed or removed backend methods before they fail at runtime on the device.",
    inputSchema: noArgs,
  },
  {
    name: "plugin_lintFocus",
    description:
      "Check a plugin's D-pad focus wiring from source: one-way moves, unreachable controls, controls with no A-button action, banned focus patterns, and sections that reveal or remove focus stops. Static only - it does not render or use a Deck, so it cannot check visual ordering. For 'does this press actually work on hardware', use deck_assertFocusMove.",
    inputSchema: {
      type: "object" as const,
      properties: {
        pluginRoot: {
          type: "string",
          description: "Plugin directory to check. Defaults to the current workspace root.",
        },
      },
      additionalProperties: false,
    },
  },

  // ---- Preview: lifecycle ------------------------------------------------
  {
    name: "preview_start",
    description:
      "Start the in-IDE QAM preview (Vite sandbox plus the Python sidecar that serves real main.py RPC).",
    inputSchema: noArgs,
  },
  {
    name: "preview_stop",
    description: "Stop the preview and its child processes.",
    inputSchema: noArgs,
  },
  {
    name: "preview_status",
    description: "Whether the preview is running, and its URL and discovered RPC allowlist.",
    inputSchema: noArgs,
  },
  {
    name: "preview_health",
    description:
      "Deeper health check of the running preview than preview_status: verifies the sandbox and sidecar actually respond.",
    inputSchema: noArgs,
  },
  {
    name: "preview_readLog",
    description: "Read recent preview log lines (mount errors, RPC failures, focus events).",
    inputSchema: {
      type: "object",
      properties: { lines: { type: "number", default: 50 } },
      additionalProperties: false,
    },
  },

  // ---- Preview: input & focus graph --------------------------------------
  {
    name: "preview_injectFocusEvent",
    description:
      "Send one D-pad or button event into the preview's focus graph. For multi-step navigation prefer preview_runSequence, which batches and can snapshot the result.",
    inputSchema: {
      type: "object",
      properties: {
        direction: { type: "string", description: `One of: ${DIRECTIONS}.` },
      },
      required: ["direction"],
      additionalProperties: false,
    },
  },
  {
    name: "preview_runSequence",
    description:
      "Drive a scripted run of input events through the preview and optionally snapshot the result. The main tool for verifying D-pad navigation and focus behaviour without a device.",
    inputSchema: {
      type: "object",
      properties: {
        inputs: {
          type: "array",
          items: { type: "string" },
          description: `Ordered input events. Each is one of: ${DIRECTIONS}.`,
        },
        delayMs: { type: "number", default: 80, description: "Delay between inputs." },
        hwOverrides: {
          type: "object",
          description: "Hardware simulator values to apply before the run (see preview_setHardware).",
          additionalProperties: true,
        },
        snapshot: {
          type: "string",
          enum: ["dom", "screenshot", "both"],
          description: "What to capture after the sequence completes.",
        },
      },
      required: ["inputs"],
      additionalProperties: false,
    },
  },

  // ---- Preview: inspection ------------------------------------------------
  {
    name: "preview_snapshotDom",
    description:
      "Capture the preview's rendered DOM plus which element currently owns focus. Cheaper and more precise than a screenshot when asserting structure or focus ownership.",
    inputSchema: {
      type: "object",
      properties: {
        selector: { type: "string", description: "Subtree to capture. Defaults to the plugin root." },
        attrs: { type: "array", items: { type: "string" }, description: "Attributes to include." },
        text: { type: "string", description: "Restrict output to nodes matching this text." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "preview_captureScreenshot",
    description:
      "Screenshot the in-IDE preview via html2canvas. Approximate, not pixel-perfect — for real rendering use deck_captureScreenshot on a device.",
    inputSchema: {
      type: "object",
      properties: { selector: { type: "string", description: "Element to capture; defaults to root." } },
      additionalProperties: false,
    },
  },
  {
    name: "preview_compareScreenshot",
    description:
      "Compare the preview against a stored visual baseline and report the pixel difference. Set updateBaseline to accept the current rendering as the new reference.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Baseline name under tests/preview-baselines/." },
        selector: { type: "string", description: "Element to compare; defaults to root." },
        threshold: { type: "number", description: "Allowed fraction of differing pixels (0-1)." },
        updateBaseline: {
          type: "boolean",
          default: false,
          description: "Overwrite the baseline with the current rendering instead of comparing.",
        },
      },
      required: ["name"],
      additionalProperties: false,
    },
  },

  // ---- Preview: backend RPC ----------------------------------------------
  {
    name: "preview_callRpc",
    description:
      "Call a method on the plugin's real main.py through the preview sidecar. Set collectEmitsMs to also gather decky.emit events the call produces.",
    inputSchema: {
      type: "object",
      properties: {
        method: { type: "string", description: "Backend method name as exposed by main.py." },
        args: { type: "array", description: "Positional arguments for the method." },
        collectEmitsMs: {
          type: "number",
          default: 0,
          description: "Milliseconds to keep collecting emitted events after the call returns.",
        },
      },
      required: ["method"],
      additionalProperties: false,
    },
  },
  {
    name: "preview_tailEmit",
    description:
      "Read decky.emit events streamed from the backend. Experimental. Use to verify push-style updates that preview_callRpc alone would not surface.",
    inputSchema: {
      type: "object",
      properties: {
        since: { type: "number", description: "Only events after this epoch ms." },
        lines: { type: "number", description: "Maximum events to return." },
        event: { type: "string", description: "Only events with this name." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "preview_callTestHook",
    description:
      "Invoke a test hook the plugin registered on window.__deckyPreviewTestHooks. Lets a plugin expose deterministic seams for agentic QA.",
    inputSchema: {
      type: "object",
      properties: {
        method: { type: "string", description: "Registered hook name." },
        args: { type: "array", description: "Arguments passed to the hook." },
      },
      required: ["method"],
      additionalProperties: false,
    },
  },

  // ---- Preview: simulated environment -------------------------------------
  {
    name: "preview_setHardware",
    description:
      "Set simulated hardware telemetry the plugin will read (sysfs/hwmon/psutil are intercepted). Use to exercise thermal, battery and power-state branches without a device.",
    inputSchema: {
      type: "object",
      properties: {
        cpuTemp: { type: "number", description: "CPU temperature in Celsius." },
        gpuTemp: { type: "number", description: "GPU temperature in Celsius." },
        battery: { type: "number", description: "Battery charge percentage, 0-100." },
        fanRpm: { type: "number", description: "Fan speed in RPM." },
        tdp: { type: "number", description: "Power limit in watts." },
        cpuClock: { type: "number", description: "CPU clock in MHz." },
        acPlugged: { type: "boolean", description: "Whether AC power is connected." },
        dock: { type: "boolean", description: "Whether the Deck is docked." },
      },
      additionalProperties: true,
    },
  },
  {
    name: "preview_setPermissions",
    description:
      "Toggle simulated Decky permission grants so denial paths can be tested. An approximation of real Decky permissions, not an enforcement boundary.",
    inputSchema: {
      type: "object",
      properties: {
        permissions: {
          type: "object",
          description: "Map of permission name to granted boolean.",
          additionalProperties: { type: "boolean" },
        },
      },
      required: ["permissions"],
      additionalProperties: false,
    },
  },
  {
    name: "preview_setHttpAllow",
    description:
      "Set the host:port allowlist for outbound HTTP from the preview sandbox (for example a local Ollama or the Steam Web API). Requests to hosts not listed are blocked.",
    inputSchema: {
      type: "object",
      properties: {
        allowlist: {
          type: "string",
          description: "Comma-separated host:port entries, e.g. '127.0.0.1:11434,api.steampowered.com:443'.",
        },
      },
      required: ["allowlist"],
      additionalProperties: false,
    },
  },
];

export const TOOL_NAMES: ReadonlySet<string> = new Set(TOOLS.map((t) => t.name));

export function findTool(name: string): ToolDef | undefined {
  return TOOLS.find((t) => t.name === name);
}

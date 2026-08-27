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
      "Snapshot of the whole dev environment: tunnel running, debug-ingest count and port, whether the Deck answers, whether Ollama is reachable, and whether the ESP32 controller bridge can open its configured COM port (bridgeReady/bridgePort/bridgeReason). Cheap — call this first when diagnosing why something is not working.",
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
    name: "deck_stopAutomation",
    description:
      "KILLSWITCH. Stop all Deck automation immediately and latch it off: release every button the bridge board is holding, abort any in-flight deck_runSequence / deck_walkTo / deck_openPlugin, tear down the SSH tunnels, and refuse every further press until a HUMAN re-arms it. Call this the moment something looks wrong \u2014 the ring on a control you did not expect, a sequence going somewhere you did not intend, a press that activated something. It is always safe to call: it presses nothing, it is idempotent, and stopping a run that was fine costs one re-arm. You CANNOT undo this yourself; there is deliberately no arming tool, because an agent that can clear its own killswitch does not have one. Re-arming is a status bar click or the 'Decky: Arm Deck Automation' command in the user's editor.",
    inputSchema: {
      type: "object",
      properties: {
        reason: {
          type: "string",
          description:
            "Why you are stopping, in one line. Recorded in the latch file and shown to the user when they go to re-arm, so write it for the person who has to decide whether it is safe to continue.",
        },
        port: {
          type: "string",
          description: "Serial port of the bridge's COM side, if not the default.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "deck_automationStatus",
    description:
      "Whether the Deck automation killswitch is armed or latched off, when and by whom it was stopped, and which SSH tunnels are currently live across every studio process. Check this first when a press refuses and you are not sure whether the bridge is broken or a human stopped you \u2014 the two look identical from a single failed press and have opposite responses.",
    inputSchema: noArgs,
  },
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
      "Open this plugin's panel on the Deck by driving Steam through the bridge board, verifying every stage against a live focus read rather than replaying a fixed button sequence. It only uses the D-pad while searching, and only presses A once a read confirms the ring is on a control labelled with the plugin's name, so it cannot activate something in an unrelated menu. If it runs out of budget it refuses and returns the manual checklist plus the list of controls it actually saw. Pass drive:false for the old checklist-only behaviour.",
    inputSchema: {
      type: "object" as const,
      properties: {
        pluginName: {
          type: "string",
          description: "Label to look for in the Decky list. Defaults to the workspace plugin's name.",
        },
        drive: {
          type: "boolean",
          default: true,
          description: "false returns the manual checklist without pressing anything.",
        },
        tabBudget: { type: "number", default: 10, description: "Max D-pad presses to find the Decky tab." },
        listBudget: { type: "number", default: 25, description: "Max D-pad presses to find the plugin's row." },
        port: { type: "string", description: "Serial port of the bridge's COM side." },
        cdpUrl: { type: "string", description: "Existing CDP endpoint; omit to open a temporary tunnel." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "deck_readPage",
    description:
      "Ask the plugin's own page a question and get the answer back as JSON. deck_readFocus answers exactly one thing — where the gamepad ring is — and almost every real investigation needs a second question it cannot answer: is this element mounted, is it wrapped in the tag we think, which panel is on screen, has the reply finished, what are this tab's controls called. READ, DO NOT DRIVE: this runs JavaScript in the Steam client so it CAN change the page, and it must not be used to. A DOM write that makes the UI look right proves nothing about whether a user could have reached that state with a controller, and asserting on UI you drove by script is the exact no-op-fix shape this rig exists to remove — if you want the UI to change, press a button. The expression must EVALUATE to a JSON-serialisable value: wrap statements in an IIFE and return plain data, never DOM nodes.",
    inputSchema: {
      type: "object" as const,
      properties: {
        expression: {
          type: "string",
          description:
            "JavaScript expression evaluated in the page, e.g. (() => ({ ladders: document.querySelectorAll('.bonsai-chip-ladder').length }))()",
        },
        target: {
          type: "string",
          description:
            "CEF target title to run against. Defaults to the Quick Access Menu, which is where Decky plugins render.",
        },
        timeoutMs: { type: "number", default: 10000 },
        cdpUrl: { type: "string", description: "Existing CDP endpoint; omit to open a temporary tunnel." },
      },
      required: ["expression"],
      additionalProperties: false,
    },
  },
  {
    name: "deck_waitFor",
    description:
      "Poll a page expression until it is satisfied, over a single tunnel. Use it to wait for a reply to finish streaming, a panel to mount, or a state to settle, instead of sleeping a guessed number of seconds or opening a fresh tunnel per check. Stops on the first truthy value, or on an exact match when `equals` is given. A timeout is NOT an error — 'the reply never finished within 60s' is a finding, and the last value seen comes back so you can see how far it got. Same read-only contract as deck_readPage.",
    inputSchema: {
      type: "object" as const,
      properties: {
        expression: { type: "string", description: "Expression to poll, as for deck_readPage." },
        equals: {
          description: "Stop when the value equals this (compared as JSON). Omit to stop on any truthy value.",
        },
        waitMs: { type: "number", default: 30000, description: "How long to keep asking." },
        intervalMs: { type: "number", default: 500, description: "Gap between reads." },
        target: { type: "string", description: "CEF target title. Defaults to the Quick Access Menu." },
        cdpUrl: { type: "string", description: "Existing CDP endpoint; omit to open a temporary tunnel." },
      },
      required: ["expression"],
      additionalProperties: false,
    },
  },
  {
    name: "deck_walkTo",
    description:
      "Move the Deck's focus ring one direction until it lands on a control with the given text, reading focus after every single press. This is how you get the ring somewhere before asserting anything, and it is a search rather than a guess: no press count is assumed, and the label that actually matched is reported back. It only ever sends direction presses, never A/B/START, so a walk cannot activate a control or launch anything — acting on what it finds is the caller's job. Matching is substring by default and also considers the nearest labelled ancestor, because Decky's ToggleField puts the ring on an unlabelled inner div. Watch for near-misses: walking to \"ask\" stops on \"Attach screenshot to Ask\"; pass exact:true when the name is a common word. A walk whose ring stops moving reports stalled:true rather than burning its budget on a dead end.",
    inputSchema: {
      type: "object" as const,
      properties: {
        direction: {
          type: "string",
          enum: ["UP", "DOWN", "LEFT", "RIGHT"],
          description: "Which way to walk. Only directions are accepted.",
        },
        text: {
          type: "string",
          description: "Text to look for on the focused control or its nearest labelled ancestor.",
        },
        exact: {
          type: "boolean",
          default: false,
          description: "Require the whole label to equal text rather than contain it.",
        },
        budget: { type: "number", default: 20, description: "Max presses before giving up." },
        stallLimit: {
          type: "number",
          default: 3,
          description: "Give up after this many presses that do not move the ring.",
        },
        acquireFocus: {
          type: "boolean",
          default: true,
          description:
            "When nothing owns the ring — which is the state right after a plugin opens, and after an Ask finishes — spend one press placing it and carry on. Set false only when the unowned state is itself what you are testing.",
        },
        port: { type: "string", description: "Serial port of the bridge's COM side." },
        cdpUrl: { type: "string", description: "Existing CDP endpoint; omit to open a temporary tunnel." },
      },
      required: ["direction", "text"],
      additionalProperties: false,
    },
  },
  {
    name: "deck_runSequence",
    description:
      "Run a list of button presses on the Deck unattended, asserting where focus lands at each one, over a single SSH tunnel. Use this instead of calling deck_assertFocusMove in a loop: it is much faster (one tunnel, not one per press), it writes an evidence file, and it detects cycles — a focus ring that returns to somewhere it has already been. That last one matters because a focus graph can trap the ring in a region with no way out while every individual press still reports moved:true and matched:true; no per-step assertion can see it, because the defect is a property of the path rather than of any one edge. The cycle report is a measurement, not a verdict — a tab bar that wraps is a legitimate cycle.",
    inputSchema: {
      type: "object" as const,
      properties: {
        steps: {
          type: "array",
          description: "Ordered steps. Each is one press plus an optional assertion.",
          items: {
            type: "object",
            properties: {
              press: {
                oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
                description: "Button(s) for this step, as for deck_pressButton. A list is a chord.",
              },
              expect: {
                type: "string",
                description: "CSS selector focus should match after this press. Omit to just record where it went.",
              },
              label: { type: "string", description: "Human name for this step, used in the log." },
              holdMs: { type: "number", default: 80 },
              settleTimeoutMs: { type: "number", default: 2500 },
            },
            required: ["press"],
            additionalProperties: false,
          },
        },
        stopOnFailure: {
          type: "boolean",
          default: true,
          description: "Stop at the first failed assertion. A run that has gone off the rails produces noise afterwards.",
        },
        mustReachText: {
          type: "array",
          items: { type: "string" },
          description:
            "Labels that must show up somewhere during the run, matched case-insensitively against each visited element's text and aria-label. The cheap way to express 'Retry must stay reachable'.",
        },
        runName: { type: "string", description: "Name for the evidence file. Defaults to a timestamp." },
        writeEvidence: { type: "boolean", default: true, description: "Set false to skip the evidence file." },
        acquireFocus: {
          type: "boolean",
          default: true,
          description:
            "When nothing owns the ring — which is the state right after a plugin opens, and after an Ask finishes — spend one press placing it before the run starts. Set false only when the unowned state is itself what you are testing.",
        },
        port: { type: "string", description: "Serial port of the bridge's COM side." },
        cdpUrl: { type: "string", description: "Existing CDP endpoint; omit to open a temporary tunnel." },
      },
      required: ["steps"],
      additionalProperties: false,
    },
  },
  {
    name: "deck_pressButton",
    description:
      "Deliver a real controller press to the Deck through the ESP32 bridge board, which Steam sees as a USB gamepad and routes through Steam Input. This is the only press that proves anything about D-pad wiring; if the bridge is unavailable it refuses rather than falling back to a synthetic press, because a synthetic one proves a handler ran and nothing more. To press AND check what happened, use deck_assertFocusMove instead.",
    inputSchema: {
      type: "object" as const,
      properties: {
        buttons: {
          type: "array",
          items: { type: "string" },
          description:
            "One or more of UP DOWN LEFT RIGHT A B X Y LB RB SELECT START GUIDE L3 R3. Several at once is a chord, e.g. [GUIDE, A] opens the Quick Access Menu.",
        },
        holdMs: { type: "number", default: 80, description: "How long to hold the press." },
        port: { type: "string", description: "Serial port of the bridge's COM side, e.g. COM7." },
      },
      required: ["buttons"],
      additionalProperties: false,
    },
  },
  {
    name: "deck_assertFocusMove",
    description:
      "Press a button on the Deck and report what Steam's nav graph actually did, reading focus before and after. Reports 'moved' and 'matched' separately, which is the point: moved=false means the press never landed anywhere, while moved=true with matched=false means the press arrived and focus went somewhere other than the target - a wiring bug rather than a missing handler. Needs both the bridge board and a Deck reachable over SSH; it refuses rather than guessing when either is missing.",
    inputSchema: {
      type: "object" as const,
      properties: {
        press: {
          type: "array",
          items: { type: "string" },
          description: "Button(s) to press, as for deck_pressButton.",
        },
        expect: {
          type: "string",
          description:
            "CSS selector the focused element should match afterwards. Omit to just report where focus went.",
        },
        holdMs: { type: "number", default: 80 },
        settleTimeoutMs: {
          type: "number",
          default: 2500,
          description: "How long to keep reading focus until it stops changing.",
        },
        port: { type: "string", description: "Serial port of the bridge's COM side." },
        cdpUrl: { type: "string", description: "Existing CDP endpoint; omit to open a temporary tunnel." },
      },
      required: ["press"],
      additionalProperties: false,
    },
  },
  {
    name: "deck_readFocus",
    description:
      "Report what Steam's gamepad nav graph actually owns on the connected Deck, read over CDP. Returns the gpfocus element and its gpfocuswithin ancestors, plus document.activeElement as a contrast field and an 'agree' flag - the two disagree often on Deck, and believing activeElement is what makes a focus fix look successful when nothing moved. Needs a Deck reachable over SSH with CEF debugging enabled; it opens and closes its own forward tunnel. This reads focus, it does not move it - to check that a press actually lands, press with the bridge and read focus before and after.",
    inputSchema: {
      type: "object" as const,
      properties: {
        cdpUrl: {
          type: "string",
          description:
            "Existing CDP endpoint, e.g. http://127.0.0.1:8080. Omit to open a temporary SSH forward to the configured Deck.",
        },
      },
      additionalProperties: false,
    },
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

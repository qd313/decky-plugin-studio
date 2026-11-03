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

/**
 * The optional `outDir` of every tool that writes run files (plan 12 lane B).
 * Absolute, or relative to the workspace root; created if missing. An empty
 * string, a filesystem root, or a path that is an existing file is refused
 * before the call does anything. deck_getEnv reports the defaults as `artifactDirs`.
 */
function outDirArg(subdir: "runs" | "screenshots" | "recordings"): Record<string, unknown> {
  return {
    type: "string",
    description:
      `Folder to write this call's files to instead of '<workspace>/${subdir}': an absolute path, or one relative to the workspace root. ` +
      "Created if missing. Refused up front (nothing is pressed) when empty, a filesystem root, or an existing file. " +
      "deck_getEnv reports the defaults under artifactDirs.",
  };
}

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

export const TOOLS: ToolDef[] = [
  // ---- Deck: configuration & status ------------------------------------
  {
    name: "deck_configure",
    description:
      "Persist Steam Deck connection settings (deck IP, user, SSH details) to the studio's deck.env. Call once before remote deploy or tunnel operations. With `machine` set, instead adds or changes that machine's entry in machines.json (a stand-in Deck: a Bazzite VM, or this PC running Steam Big Picture with Decky) -- pass the entry's fields alongside; `remove: true` deletes it; `makeDefault: true` makes it the machine used when a call names none. The `deck` machine's address always comes from deck.env.",
    inputSchema: {
      type: "object",
      properties: {
        DECK_IP: { type: "string", description: "Steam Deck IP address on the LAN." },
        DECK_USER: { type: "string", default: "deck", description: "SSH user on the Deck." },
        machine: {
          type: "string",
          description:
            "Registry name of the machine to add or change (letters, digits, dot, dash, underscore). Omit to write deck.env as before.",
        },
        kind: { type: "string", enum: ["deck", "standin"], description: "The real Deck, or a stand-in. Default standin for any name but deck." },
        os: { type: "string", enum: ["steamos", "bazzite", "windows"], description: "What the machine runs. Default bazzite for a stand-in." },
        local: {
          type: "boolean",
          description:
            "true when this server process runs ON the machine itself (this PC as a stand-in): no SSH, no tunnels, local paths. Default false.",
        },
        host: { type: "string", description: "SSH host (IP, name, or a ~/.ssh/config alias carrying a non-22 port). Remote machines only." },
        user: { type: "string", description: "SSH user. Default deck." },
        press: {
          type: "string",
          enum: ["bridge", "uinput", "vigem", "none"],
          description:
            "How a press reaches it: bridge = the ESP32 board on a serial port; uinput = vpad.py on a Linux machine over the shared tunnel; vigem = vpad.py on this Windows PC (must be local); none = reads only.",
        },
        bridgePort: { type: "string", description: "bridge only: serial port on this PC, e.g. COM7 or /dev/ttyACM0." },
        padPort: { type: "number", description: "uinput/vigem only: TCP port vpad.py serves on, on the machine. Default 7690." },
        cdpPort: { type: "number", description: "Steam's CEF debugger port on the machine. Default 8080." },
        pluginsDir: { type: "string", description: "Where Decky keeps plugins on the machine. Default ~/homebrew/plugins." },
        vm: {
          type: "object",
          description: "For a VM: { hypervisor: 'virtualbox' | 'qemu', name } so the host scripts can find it.",
          properties: {
            hypervisor: { type: "string", enum: ["virtualbox", "qemu"] },
            name: { type: "string" },
          },
        },
        note: { type: "string" },
        remove: { type: "boolean", description: "Delete this machine's entry." },
        makeDefault: { type: "boolean", description: "Use this machine when a call names none." },
      },
      // Any further KEY=VALUE pairs are written to deck.env verbatim.
      additionalProperties: true,
    },
  },
  {
    name: "deck_listMachines",
    description:
      "Every machine this server can drive -- the real Deck (from deck.env) and any stand-ins in machines.json -- with each one's kind (deck or standin), os, whether it is local, its press transport, who holds its lease right now (only one driver at a time), and whether it is stopped by the killswitch. Call this to learn what to pass as `machine` on any deck_* tool. Read-only.",
    inputSchema: noArgs,
  },
  {
    name: "deck_releaseMachine",
    description:
      "Release a machine's driving lease. Every driving call (press, deploy, reload, sweep...) takes the lease for this session automatically and keeps it until the session ends, it goes ten minutes without a call, or this is called. Releasing your own is always allowed. A lease held by ANOTHER live session needs `force: true`, which evicts them -- their next driving call will refuse. Do that only when the user says that session is gone; the refusal you got names the holder and when it expires on its own.",
    inputSchema: {
      type: "object",
      properties: {
        machine: { type: "string", description: "Machine name. Default: the registry default (normally deck)." },
        force: { type: "boolean", default: false, description: "Evict another session's live lease." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "deck_status",
    description:
      "Snapshot of the whole dev environment: tunnel running, debug-ingest count and port, whether the Deck answers, whether Ollama is reachable, and whether the ESP32 controller bridge's COM port opens on THIS PC and its firmware answers (bridgePortOpen/bridgePort/bridgeReason), and bridgeFirmware, the program the board says it runs (\"07_version\"; \"unknown (pre-07)\" when it answered with no name, which only a board flashed before 07_version does; another \"unknown (...)\" when it was not asked or did not answer; never worked out from the resting axes; a stand-in's virtual pad says \"vpad\"). bridgePortOpen says nothing about whether the board's other USB lead reaches the Deck — a board plugged into the PC but unplugged from the Deck still reports it true. `bridgeReady` is the same value under its old, misleading name — deprecated, kept only for an existing consumer (bonsAI); use bridgePortOpen. On a Windows machine it also reports bigPicture: { foreground, visibilityState, hasFocus } -- whether Big Picture is the window in front (foreground is true, false, or 'unknown' when its page cannot be read). Cheap — call this first when diagnosing why something is not working.",
    inputSchema: noArgs,
  },
  {
    name: "deck_focusBigPicture",
    description:
      "Windows stand-in only: put Steam Big Picture back in front without a hand, so a run does not need the maintainer to open Big Picture or alt-tab to it first. If no Big Picture page is listed and Steam reports UI mode 7 (the desktop client), it switches Steam to Big Picture (SteamClient.UI.SetUIMode(4) in SharedJSContext) and waits up to `modeSwitchWaitMs` for the page; `uiModeBefore` in the result says what it found (measured 2026-10-25: Decky's loader survives the switch and its Quick Access tab is in the rebuilt window). Then it reads the foreground gate (the same reading deck_status's bigPicture and deck_checkReady's foreground use), then: if Steam says its window is minimized, one Win32 ShowWindow(SW_RESTORE) through the packaged restore-window.ps1 (Steam cannot restore its own window); then Steam's own SteamClient.Window.BringToFront(1) and a SetKeyFocus off/on toggle over CDP; then reads the gate again. Presses nothing, takes no lease. `ok` is true only when the second read says Big Picture is in front -- the result carries `before`, `after`, `wasMinimized` and `steps`, so nothing has to be taken on this tool's word. Already in front: nothing is done, ok true, steps empty. On steamos/bazzite it refuses: Big Picture is the only window there. Measured on the maintainer's PC 2026-10-25 for the covered and the minimized cases.",
    inputSchema: {
      type: "object",
      properties: {
        settleMs: { type: "number", default: 700, description: "How long to give Windows before the second gate read, in ms." },
        modeSwitchWaitMs: { type: "number", default: 20000, description: "When Steam was in desktop mode: how long to wait for the Big Picture page after switching, in ms." },
        timeoutMs: { type: "number", default: 4000, description: "Budget per CDP call, in ms." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "deck_getEnv",
    description:
      "Read back the currently configured Deck environment (IP, user, paths) without modifying it. `artifactDirs` is where run files land when a call names no outDir: runs (deck_sweep, deck_runSequence, deck_launchGame, deck_exitGame evidence), screenshots (deck_captureScreenshot) and recordings (deck_record), each under the workspace root.",
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
        machine: {
          type: "string",
          description:
            "Stop ONE machine (a stand-in that is misbehaving while the real Deck's run should go on): its own latch is set, its pad released, its tunnels cut. Omit to stop everything, which is the right call whenever you are not sure.",
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
      "Take a composited screenshot on the real Deck (QAM and Decky overlays included in game mode) and save it to the workspace screenshots directory. On a Windows stand-in it captures the Big Picture page over Steam's CEF debugger (Page.captureScreenshot, method \"cdp\"), falling back to a PowerShell window grab (method \"window-grab\"); the Quick Access menu is not composited in.",
    inputSchema: {
      type: "object",
      properties: { mode: CAPTURE_MODE, allowNonPluginUi: ALLOW_NON_PLUGIN_UI, outDir: outDirArg("screenshots") },
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
        outDir: outDirArg("recordings"),
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
      "Build and install the current plugin onto Decky Loader, restart the loader, and — by default — wait until the Deck is usable again: the loader active and Steam's UI pages listed over CDP. The main deploy verb — use before on-device QA. The result's `loader` block reports the wait; `loader.ready: false` means the deadline passed and the next deck_* call may still land in the restart (deck_openPlugin needed 2-3 attempts after every deploy before this wait existed).",
    inputSchema: {
      type: "object",
      properties: {
        mode: DEPLOY_MODE,
        waitForLoader: {
          type: "boolean",
          default: true,
          description:
            "After the plugin_loader restart, poll the Deck until the loader is active and Steam lists a UI page over CDP before returning. false returns as soon as the restart is issued, as before.",
        },
        loaderTimeoutMs: {
          type: "number",
          default: 30000,
          description: "Upper bound on that wait; the result's `loader.ready` says whether it was met.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "deck_reloadPlugin",
    description:
      "Reload just this plugin without a full redeploy. Faster than deck_deploy when only backend Python changed and the bundle is already installed. Restarts the loader and, by default, waits until the Deck is usable again, as deck_deploy does; see its `loader` block.",
    inputSchema: {
      type: "object",
      properties: {
        mode: DEPLOY_MODE,
        waitForLoader: {
          type: "boolean",
          default: true,
          description:
            "After the plugin_loader restart, poll the Deck until the loader is active and Steam lists a UI page over CDP before returning. false returns as soon as the restart is issued, as before.",
        },
        loaderTimeoutMs: {
          type: "number",
          default: 30000,
          description: "Upper bound on that wait; the result's `loader.ready` says whether it was met.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "deck_probeDebugger",
    description:
      "Record what Steam's CEF debugger does after a plugin_loader restart, sample by sample -- the measurement issue #3 (deck_openPlugin failing its first try after a reload) has never had. Every 250 ms for `seconds` it lists the CDP targets, opens a socket to SharedJSContext and one to the Quick Access page and runs one trivial Runtime.evaluate in each, and records per sample: the targets listed (ids and titles), each connect's outcome (ok, ECONNRESET, 'socket hang up', ECONNREFUSED, timeout, http-error, closed, not-listed, error), whether Decky's tab is on the Quick Access rail (Decky's pane mounted in that page, the same read deck_openPlugin waits on), and the ms since the restart note. Read-only: it presses nothing and, without afterReload, takes no lease. With afterReload: true it restarts plugin_loader itself first, through deck_reloadPlugin's code with no loader wait (that takes the lease, like the reload), and samples from the moment the restart command returns. Writes runs/probe-debugger_<ts>.json with every sample and returns the leading numbers -- firstReadableQuickAccessMs, quickAccessStableFromMs, firstDeckyTabMs, resetsSeen, lastResetMs -- plus per-channel outcome counts and a compact timeline of the distinct states seen. Times are ms after the restart note when one is fresh (`zero: \"restart-note\"`; the reload's `commandMs` is how long the restart command ran before that), else after the probe started. Limits: through the SSH forward a refused connect on the Deck reads here as a reset or a hang-up; a sample that waits out a 1.5 s timeout delays the next; with the Quick Access menu shut Steam may mount no panes, so open the menu first if the rail matters. Without afterReload sampling stops at 55 s, inside the 60 s read deadline.",
    inputSchema: {
      type: "object",
      properties: {
        seconds: {
          type: "number",
          default: 30,
          description: "How long to sample, 1-300 (55 at most without afterReload).",
        },
        afterReload: {
          type: "boolean",
          default: false,
          description:
            "true restarts plugin_loader first (as deck_reloadPlugin, without its loader wait) and samples from the moment the restart command returns. This is a driving call: it takes the machine's lease.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "deck_openPlugin",
    description:
      "Open this plugin's panel on the Deck by driving Steam through the bridge board, verifying every stage against a live focus read rather than replaying a fixed button sequence. It only uses the D-pad while searching, and only presses A once a read confirms the ring is on a control labelled with the plugin's name, so it cannot activate something in an unrelated menu. If it runs out of budget it refuses and returns the manual checklist plus the list of controls it actually saw. Set rootSelector (or panelRootSelector in .decky/preview.json) to a selector your panel renders: without it, 'is the panel already open' is inferred from Decky's pane labels, and Decky's plugin LIST advertises every installed plugin's name, so an unmounted panel can read as open. Pass drive:false for the old checklist-only behaviour. Safe to call straight after deck_deploy: the first read waits out the loader restart, and the QAM open chord (a toggle) is fired only on the Quick Access page's own report that the menu is shut — never on a null read from another page. If the first try fails with nothing pressed, or with only the open chord pressed (seen right after deck_reloadPlugin), the tool reads again and tries once more inside the same call; the result then carries a `retried` object (why the first try failed) and says so in `summary`, and the stages are prefixed try1: and try2:.",
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
        rootSelector: {
          type: "string",
          description:
            "CSS selector for an element the plugin's own panel renders, e.g. '.bonsai-scope'. Decides whether the panel is open — both ways — instead of guessing from Decky's pane labels, and confirms the panel mounted after the A press. Defaults to panelRootSelector in .decky/preview.json.",
        },
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
      "Move the Deck's focus ring one direction until it lands on a control with the given text, reading focus after every single press. This is how you get the ring somewhere before asserting anything, and it is a search rather than a guess: no press count is assumed, and the label that actually matched is reported back. It only ever sends direction presses, never A/B/START, so a walk cannot activate a control or launch anything — acting on what it finds is the caller's job. Matching is substring by default, against the control's accessible name: its own aria-label first, then its text, and only then a labelled ancestor's — because Decky's ToggleField puts the ring on an unlabelled inner div, while an icon-only tab would otherwise inherit the text of the whole pane it sits in. Text too long to be a name is refused rather than matched, and the walk reports overshot:true when that happened. Watch for near-misses: walking to \"ask\" stops on \"Attach screenshot to Ask\"; pass exact:true when the name is a common word. A walk whose ring stops moving reports stalled:true rather than burning its budget on a dead end.",
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
          description:
            "Text to look for in the focused control's accessible name (own aria-label, then its text, then a labelled ancestor's).",
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
    name: "deck_typeText",
    description:
      "Type text into the plugin's own field by CDP injection (Input.insertText) -- NOT through the controller, the bridge or Steam's on-screen keyboard, so the result's fidelity is \"injected\", ranked below \"wire-sent\", and it proves nothing about the path a person uses to type: a field that takes injected text works, which is a different fact from a controller being able to fill it. The honest fallback until a bridge keyboard exists; never file it as steam-routed. It reads focus first and writes ONLY to the element the gamepad ring (gpfocus, not document.activeElement) is on, and only when that element is an <input> of a text type, a <textarea> or a contenteditable host, inside the plugin's panel (the panel root selector when known -- rootSelector, else panelRootSelector in .decky/preview.json -- otherwise Decky's plugin pane on the Quick Access page). Anything else is refused with what was found instead: a wrapper that merely contains an input, a checkbox, a Steam page's own field (not ours to fill by injection), or an unowned ring (it presses nothing and never places the ring: use deck_walkTo first). It calls DOM focus() on that element only because the ring already sits there; it never moves the ring. clear:true first empties the field through the native value setter plus an input event (the way React notices a change; a contenteditable host is cleared by select-all and execCommand delete) and refuses to type if the field did not empty; cleared.method says which ran. The result reads the field back: valueBefore, expected, valueAfter and matched (false if a maxlength, a controlled field or newlines in a one-line input changed the text), and ok is true only when it matched. submit:true then dispatches Enter as a DOM key event (Input.dispatchKeyEvent keyDown + keyUp) and reports it in `submit`, with the field's value afterwards in valueAfterSubmit; it never presses A, and it is not sent when the text did not read back or the field lost DOM focus. Driving tool: takes the machine's lease and obeys the killswitch. Default deadline 60 s, not the 10 minutes other driving tools get. Not yet measured on a Deck.",
    inputSchema: {
      type: "object" as const,
      properties: {
        text: {
          type: "string",
          description: "What to type. May be empty when clear or submit is the point. Inserted at the end of the field's current text unless clear is set.",
        },
        submit: {
          type: "boolean",
          default: false,
          description: "After the text reads back as expected, send Enter with Input.dispatchKeyEvent (keyDown + keyUp). Never presses A.",
        },
        clear: {
          type: "boolean",
          default: false,
          description: "Empty the field first instead of appending. Stops before typing if the field would not clear.",
        },
        rootSelector: {
          type: "string",
          description:
            "CSS selector for the plugin's own panel root, which decides what counts as the plugin's page. Defaults to panelRootSelector in .decky/preview.json; without either, Decky's plugin pane (quickaccess_content_999) on the Quick Access page.",
        },
        cdpUrl: { type: "string", description: "Existing CDP endpoint; omit to open a temporary tunnel." },
      },
      required: ["text"],
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
              requireVisible: {
                type: "boolean",
                description:
                  "Fail this step unless a person could see where the ring landed (visibility.verdict === 'visible'), the way expect fails it on the wrong element. Overrides the run-level requireVisible.",
              },
              holdMs: { type: "number", default: 80 },
              settleTimeoutMs: { type: "number", default: 2500 },
            },
            required: ["press"],
            additionalProperties: false,
          },
        },
        requireVisible: {
          type: "boolean",
          default: true,
          description:
            "Fail any step whose landing spot a person could not see — covered by another element, clipped by an overflow, or off screen (the summary names the covering selector). Default TRUE: a covered stop is a failure. Pass false to opt out for the run (a step's own requireVisible still overrides): the verdict is then still measured on every step, reported as step.visibility, counted in stopsFocusedButNotVisible and shouted in the summary, but does not fail the run.",
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
            "Labels that must show up somewhere during the run, matched case-insensitively against each visited control's accessible name (own aria-label, then its text, then a labelled ancestor's). The cheap way to express 'Retry must stay reachable'.",
        },
        runName: { type: "string", description: "Name for the evidence file under runs/. Naming a run is what makes it write one." },
        outDir: outDirArg("runs"),
        writeEvidence: {
          type: "boolean",
          description:
            "Write the evidence file. Default: only when runName is given, so unnamed exploratory runs leave nothing behind. true forces a write, false skips it.",
        },
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
    name: "deck_sweep",
    description:
      "Free play, scripted: emulate a user D-padding around the open pane and record what they would have found at every stop. Walks one direction until the ring stops moving or returns somewhere it has been, walks back, optionally repeats per carousel lane (LB/RB), and at EVERY stop records the control's label, selector, rect, the pane's scrollTop and the visibility verdict — whether a person could actually SEE the focused control, or whether it is covered by another element, clipped, or off screen. Same safety model as deck_walkTo: only direction presses and LB/RB, never A/B/START, so a sweep cannot activate anything. Writes a runs/ report built for diffing — rows plus totals (stopsRecorded, stopsVisited, unlabeledStops, cycles, stopsFocusedButNotVisible), deterministic for a given UI state, nothing clock-dependent in the file — so a consumer commits a baseline and QA becomes sweep-then-diff with no per-control assertions: a new stop, a lost stop, or a stop that went from visible to covered each shows up as a diff line. Use it after any UI change to a pane, and read stopsFocusedButNotVisible first: nonzero is a control a user can reach with the D-pad and cannot see.",
    inputSchema: {
      type: "object" as const,
      properties: {
        direction: {
          type: "string",
          enum: ["UP", "DOWN", "LEFT", "RIGHT"],
          default: "DOWN",
          description: "Primary walk direction. Only directions are accepted.",
        },
        returnTrip: {
          type: "boolean",
          default: true,
          description: "Walk back the opposite way after the primary leg ends, so each control is read scrolled both ways.",
        },
        lanes: {
          type: "number",
          default: 0,
          description: "Extra carousel positions to repeat the walk in, reached by pressing laneButton between them.",
        },
        laneButton: {
          type: "string",
          enum: ["LB", "RB"],
          default: "RB",
          description: "Shoulder button that changes lane. Nothing else is accepted.",
        },
        budget: { type: "number", default: 80, description: "Total presses for the whole sweep, lane presses included." },
        stallLimit: {
          type: "number",
          default: 2,
          description: "A leg ends after this many presses that do not move the ring.",
        },
        acquireFocus: {
          type: "boolean",
          default: true,
          description: "When nothing owns the ring, spend one press placing it and carry on. As for deck_walkTo.",
        },
        runName: { type: "string", description: "Name for the evidence file under runs/. Defaults to sweep_<timestamp>." },
        writeEvidence: { type: "boolean", default: true, description: "Set false to skip the evidence file." },
        outDir: outDirArg("runs"),
        port: { type: "string", description: "Serial port of the bridge's COM side." },
        cdpUrl: { type: "string", description: "Existing CDP endpoint; omit to open a temporary tunnel." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "deck_saveCheck",
    description:
      "Run a deck_sweep or deck_runSequence and, if it completes cleanly, save its landings as a NAMED CHECK FILE under checksDir (default '<workspace>/checks/<name>.json') in the consumer's own repo -- the file deck_replayChecks reruns later. This is how 'I just fixed this bug' becomes a check that keeps failing if it comes back, instead of a sweep report a person reads once and forgets. Only the fields that are actually facts about the plugin's landings are saved (labels, selectors, rects, focus identity, the visibility verdict, cycle/reachability findings) -- timing, press-retry counts and other run-to-run noise are stripped before saving, so a replay cannot fail for a reason that has nothing to do with the plugin. The check also records a hash of the plugin bundle it was saved against (see deck_replayChecks), NOT a version string or a timestamp. Refuses to save -- with a reason, no file written -- when the run itself did not complete cleanly (a press failed, the Deck was unreachable, the killswitch fired): a check records what 'right' looks like, and a broken run is not that.",
    inputSchema: {
      type: "object" as const,
      properties: {
        name: { type: "string", description: "Name for the check. Becomes checksDir/<name>.json (sanitized)." },
        tool: {
          type: "string",
          enum: ["deck_sweep", "deck_runSequence"],
          description: "Which tool to run and save the landings of.",
        },
        checksDir: {
          type: "string",
          description: "Directory the check file is written under. Defaults to '<workspace>/checks'.",
        },
        pluginRoot: {
          type: "string",
          description: "Plugin directory the build hash is computed from (the same files deck_deploy would ship). Defaults to the workspace root.",
        },
        sweep: {
          type: "object",
          description: "deck_sweep options, used when tool is 'deck_sweep'. Same shape as deck_sweep's own arguments.",
          properties: {
            direction: { type: "string", enum: ["UP", "DOWN", "LEFT", "RIGHT"], default: "DOWN" },
            returnTrip: { type: "boolean", default: true },
            lanes: { type: "number", default: 0 },
            laneButton: { type: "string", enum: ["LB", "RB"], default: "RB" },
            budget: { type: "number", default: 80 },
            stallLimit: { type: "number", default: 2 },
            acquireFocus: { type: "boolean", default: true },
            port: { type: "string" },
            cdpUrl: { type: "string" },
          },
          additionalProperties: false,
        },
        sequence: {
          type: "object",
          description: "deck_runSequence options, used when tool is 'deck_runSequence'. Same shape as deck_runSequence's own arguments.",
          properties: {
            steps: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  press: { oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }] },
                  expect: { type: "string" },
                  label: { type: "string" },
                  requireVisible: { type: "boolean" },
                  holdMs: { type: "number" },
                  settleTimeoutMs: { type: "number" },
                },
                required: ["press"],
                additionalProperties: false,
              },
            },
            stopOnFailure: { type: "boolean", default: true },
            mustReachText: { type: "array", items: { type: "string" } },
            requireVisible: { type: "boolean", default: true },
            acquireFocus: { type: "boolean", default: true },
            port: { type: "string" },
            cdpUrl: { type: "string" },
          },
          additionalProperties: false,
        },
      },
      required: ["name", "tool"],
      additionalProperties: false,
    },
  },
  {
    name: "deck_replayChecks",
    description:
      "Rerun every saved check under checksDir (default '<workspace>/checks') against the CURRENT build and diff each against what it recorded when it passed -- the loop a person used to do by hand after every build. For each check, first compares a fresh hash of the plugin bundle (the same files deck_deploy would ship, from pluginRoot) against the hash recorded when the check was saved: a mismatch is reported as 'this check has never been verified against what is running now' -- distinct from a landing diff, and no landing comparison is even attempted in that case, because comparing across two different builds would not prove anything either way. When the build matches, a differing landing is named specifically -- which stop or step, which field, expected versus actual -- never just a pass/fail count. A malformed or truncated check file is reported by name under `errors` rather than crashing the rest of the replay. Pass `names` (alias `only`) to replay a subset by saved name. With NO names, a directory holding more than maxChecks files (default 10) is REFUSED before anything runs, naming the count: each check is a walk of real presses, and a replay of 100 saved walks ran for 25 minutes on a Deck in a random state and changed a setting (bonsAI, 2026-10-24). Pass `all: true` to run them all on purpose.",
    inputSchema: {
      type: "object" as const,
      properties: {
        checksDir: { type: "string", description: "Directory to read check files from. Defaults to '<workspace>/checks'." },
        pluginRoot: {
          type: "string",
          description: "Plugin directory the current build hash is computed from. Defaults to the workspace root.",
        },
        names: {
          type: "array",
          items: { type: "string" },
          description:
            "Replay only checks with these saved names (not filenames). With none, every check file in checksDir runs -- unless there are more than maxChecks, which is refused.",
        },
        only: {
          type: "array",
          items: { type: "string" },
          description: "The older spelling of `names`; `names` wins when both are given.",
        },
        all: {
          type: "boolean",
          default: false,
          description: "Run every check even when the directory holds more than maxChecks. Each check is a walk of real presses on the machine.",
        },
        maxChecks: {
          type: "number",
          default: 10,
          description: "Most checks an unnamed replay runs without all:true; more files than this is refused, naming the count.",
        },
        port: { type: "string", description: "Serial port of the bridge's COM side, for any deck_runSequence checks." },
        cdpUrl: { type: "string", description: "Existing CDP endpoint; omit to open a temporary tunnel per check." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "deck_pressButton",
    description:
      "Deliver a real controller press to the Deck through the ESP32 bridge board, which Steam sees as a USB gamepad and routes through Steam Input. If the bridge is unavailable it refuses rather than falling back to a synthetic press, because a synthetic one proves a handler ran and nothing more. By default this reports `fidelity: \"wire-sent\"` on success -- the firmware acknowledged the command, which is ALL that is known; it does NOT mean the Deck received anything (a board plugged into this PC but unplugged from the Deck still acks). Set verify:true to earn `fidelity: \"steam-routed\"`: it reads Steam's gamepad focus before and after the press over CDP and reports the stronger fidelity only when that focus actually changed, otherwise an honest ok:false. verify costs a CDP round trip on top of the press. A list of buttons is a SIMULTANEOUS press -- one HID report with every bit set -- which is not a chord: [GUIDE, A] that way is read by Steam as a bare GUIDE press, so the Steam main menu opens and the A lands in whatever that menu is showing (measured 2026-08-26, when the mistake was one press away from launching a game). For a real chord such as the Quick Access Menu toggle -- hold GUIDE, tap A -- use deck_pressChord. To press AND get a full moved/matched diagnosis, use deck_assertFocusMove instead.",
    inputSchema: {
      type: "object" as const,
      properties: {
        buttons: {
          type: "array",
          items: { type: "string" },
          description:
            "One or more of UP DOWN LEFT RIGHT A B X Y LB RB SELECT START GUIDE L3 R3 LT RT (LT and RT are the triggers, L2 and R2, pulled all the way). Several at once are pressed SIMULTANEOUSLY in one report -- NOT a chord: [GUIDE, A] opens the Steam main menu, not the Quick Access Menu. Use deck_pressChord for hold-then-tap.",
        },
        holdMs: { type: "number", default: 80, description: "How long to hold the press." },
        port: { type: "string", description: "Serial port of the bridge's COM side, e.g. COM7." },
        verify: {
          type: "boolean",
          default: false,
          description:
            "Earn fidelity:\"steam-routed\" by reading Steam's gamepad focus before and after the press over CDP, reporting it only when focus actually changed. Costs a CDP round trip; off by default, in which case fidelity never exceeds \"wire-sent\".",
        },
        cdpUrl: { type: "string", description: "Existing CDP endpoint for verify; omit to open a temporary tunnel." },
      },
      required: ["buttons"],
      additionalProperties: false,
    },
  },
  {
    name: "deck_pressChord",
    description:
      "Hold one button, tap another, release -- a real chord, delivered by the bridge board as four HID reports in sequence. This is how Steam's Quick Access Menu is toggled: hold GUIDE, tap A. It is NOT what deck_pressButton with [GUIDE, A] does: that sends both bits in one report, which Steam reads as a bare GUIDE press, so the main menu opens and the A lands in whatever that menu is showing (measured 2026-08-26, when the mistake was one press away from launching a game). Same refusals as deck_pressButton -- no board, or the killswitch latch -- and nothing is faked in their place. When the goal is the plugin's panel, prefer deck_openPlugin: it asks the Quick Access page whether the menu is already open before toggling it, which a raw chord cannot.",
    inputSchema: {
      type: "object" as const,
      properties: {
        hold: {
          type: "string",
          description: "Button held for the whole chord, e.g. GUIDE. One of UP DOWN LEFT RIGHT A B X Y LB RB SELECT START GUIDE L3 R3 LT RT.",
        },
        tap: { type: "string", description: "Button tapped while `hold` is down, e.g. A." },
        port: { type: "string", description: "Serial port of the bridge's COM side, e.g. COM7." },
      },
      required: ["hold", "tap"],
      additionalProperties: false,
    },
  },
  {
    name: "deck_launchGame",
    description:
      "Start a game on the Deck the way a thumb would -- Steam button, Home, the Recent Games shelf, Play -- with every stage verified against a read before the next press, so a QA row that needs 'with a game running' can set that state up itself. It reads Steam's own state over CDP (RunningApps, the app list, the main window's route) and never drives by script: no steam:// URL, no SteamClient.Apps.RunAppById, because a game started the way no thumb can is not evidence about what a thumb gets. Refuses BEFORE pressing anything when: not exactly one of name, appid, title or shelfIndex is given; a DIFFERENT game is already running (it names it and points at deck_exitGame -- it never launches a second game); the name is ambiguous (candidates listed, pass appid); or the game is not installed. A game already running returns ok with alreadyRunning:true and zero presses. It presses A only on a control the read taken just before it identified: the shelf tile by the app id in its own image (never its text), then the exact label 'Play' -- an app page showing Install, Update, Buy, Pre-load, Pre-purchase, Purchase, Add to Cart or Download is refused, because that press would spend disk or money. Only the D-pad while searching; A and GUIDE at named stages; never B, START or SELECT; the killswitch latch is checked before every press. A game that is installed but not on the Recent Games shelf is looked for in the Library grid next: Steam button again, D-pad to the main-menu entry labelled exactly 'Library', A, then the grid walked with the D-pad toward the tile whose own image carries the app id (a focus read after every press, at most `budget` presses), refusing with the last tile seen; that route is DEVICE-UNVERIFIED (the grid's markup has never been read on a Deck), and it searches only the Library tab Steam opens on. `launchRoute` in the result says where the game was found: 'shelf', 'library', or 'home' (the Home-screen route below, where the Library is out of reach). Call deck_listGames first to see the installed titles and the shelf with no press. The launch signal is the app id appearing in RunningApps (under a second on device) -- not the game's window being up; the route becomes /apprunning and the ring is left wherever Steam puts it, so reopen the plugin with deck_openPlugin, which can open the QAM over a running game. When the Steam button does not open Steam's main menu (the maintainer's Deck since 2026-10-10: the press arrives, the menu stays shut, the GUIDE+A chord still works), it takes the Home-screen route instead: the QAM closed with the GUIDE+A chord if a read shows it open, then -- only if the route reads /library/home and the ring is on a Recent Games tile -- the shelf walked RIGHT and, past its end, LEFT, then A on the tile and A on Play exactly as above; anywhere else is a refusal, because without the menu the only way Home is B, which it never presses. `via` in the result says which route was used: 'steam-menu' or 'home-screen'. Result is shaped like deck_openPlugin's (stages, seen, presses, fidelity, stopped, reason, checklist), and runs/<runName|launch-game_<ts>>.json holds the stages, the controls seen, and RunningApps before and after.",
    inputSchema: {
      type: "object" as const,
      properties: {
        name: {
          type: "string",
          description:
            "Library display name. An exact (case-insensitive) match wins; otherwise a unique contains; more than one hit is refused. A non-Steam shortcut (nonSteam: true in deck_listGames) is then matched on the shelf by this name, because its tile's image carries no app id; it is not looked for in the Library grid, and two apps sharing its exact name are refused (pass shelfIndex). Give exactly one of name / appid / title / shelfIndex.",
        },
        appid: {
          type: "number",
          description:
            "Steam app id, as listed in RunningApps and the library (a shortcut's id is matched by its library name, as for name). Give exactly one of name / appid / title / shelfIndex.",
        },
        title: {
          type: "string",
          description:
            "A Recent Games shelf tile's own text or aria-label, for a tile the library name does not reach (a non-Steam shortcut, or a label you read off the shelf). Exact (case-insensitive) first, stopping at the first tile that is exactly it; otherwise the walk reads the whole shelf and takes the one tile that contains it, walking back to it -- two or more is refused. When the title is one library app's whole name, only that app's tile counts. Shelf only: the Library grid is not searched by title. The A on the tile follows a read that names it; the app page must still read exactly 'Play'. Device-unverified: what a shortcut's tile reads was seen in a walk's `seen` list once (2026-10-25), never asserted. Give exactly one of name / appid / title / shelfIndex.",
        },
        shelfIndex: {
          type: "number",
          description:
            "0-based position on the Recent Games shelf, counted in RIGHT presses from the first tile, where A on Home puts the ring (measured). A position at or past 'View more in your Library' is refused, as is a stop that names nothing, and so is any position on the Home-screen route (the ring starts wherever it was left there). Shelf only. The result's shelfTile says which tile it was. Give exactly one of name / appid / title / shelfIndex.",
        },
        budget: {
          type: "number",
          default: 40,
          description:
            "Max D-pad presses for each search walk before refusing, every press counted: the Recent Games shelf (RIGHT, then LEFT on the Home-screen route, and the walk back to a title found by a unique contains), and separately the Library grid (any direction, including the stalled-DOWN fallback: when DOWN does not move the ring and the page shows a row below, one RIGHT then DOWN, then one LEFT then DOWN, each after a read -- device-unverified). Every grid stop's tile layout (rows by y, the focused tile, the grid's scroll container, the route) is written to the run file's gridStops.",
        },
        waitMs: {
          type: "number",
          default: 60000,
          description: "How long to poll RunningApps (1 s interval) for the app id after A on Play. A timeout is a finding, reported with the presses that were made.",
        },
        runName: { type: "string", description: "Name for the evidence file under runs/. Defaults to launch-game_<timestamp>." },
        writeEvidence: { type: "boolean", default: true, description: "Set false to skip the evidence file." },
        outDir: outDirArg("runs"),
        port: { type: "string", description: "Serial port of the bridge's COM side." },
        cdpUrl: { type: "string", description: "Existing CDP endpoint; omit to open a temporary tunnel." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "deck_exitGame",
    description:
      "Exit the running game the way a thumb would -- Steam button, Right into the game panel, Down to 'Exit game', A, then A on 'Confirm' -- with a read before every A. An empty RunningApps is not believed alone: on a steamos/bazzite machine it also asks the process list (`pgrep -af 'SteamLaunch AppId=[0-9]'`, over SSH or locally) for a Steam game process. If one is alive it refuses with processAlive:true and its pid -- the game is NOT called exited, and nothing is pressed or killed. If none is, it returns ok with nothingRunning:true, processAlive:false and zero presses; when the check could not be made (SSH down) or is skipped (windows machines skip it), processAlive is null and processCheck says why. processAlive: whether a game process was seen; pid: that process's id; processCheck: one sentence saying what was asked and what it saw. When the main menu opens on Home (or anywhere but the game's entry) with the game running underneath -- seen after a plugin reload -- it walks UP to the game's entry, reading each stop, and carries on. Refuses when no entry named after the running game is reached, when no row labelled exactly 'Exit game' (lower-case g) is found within 10 Down presses, or when the confirmation dialog leaves the ring on anything but a control labelled exactly 'Confirm' -- it never guesses between Cancel and Confirm, and reports the game still running. Only the D-pad while searching; the killswitch latch is checked before every press. Done means the app id has left RunningApps (polled 1 s up to waitMs); the measured post-exit state, reported in the result, is the main window on /library/app/<appid> with the ring on Play. When the Steam button opens no menu at all (the maintainer's Deck since 2026-10-10: the press arrives, the menu stays shut), there is no D-pad way to Exit game, so it asks Steam itself to close the game -- SteamClient.Apps.TerminateApp, Steam's own close-game call, run over the debug page after the killswitch check -- and says so: the summary starts 'closed without the Steam menu', `via` is 'steam-close-call' (else 'steam-menu'), and fidelity stays 'wire-sent' because no press closed it. A menu that opens on the wrong entry is still a refusal, never a reason to use the call. Reopen the plugin with deck_openPlugin afterwards. Writes runs/<runName|exit-game_<ts>>.json with the stages, the controls seen, and RunningApps before and after.",
    inputSchema: {
      type: "object" as const,
      properties: {
        waitMs: { type: "number", default: 60000, description: "How long to poll RunningApps for the app id to leave after A on Confirm." },
        runName: { type: "string", description: "Name for the evidence file under runs/. Defaults to exit-game_<timestamp>." },
        writeEvidence: { type: "boolean", default: true, description: "Set false to skip the evidence file." },
        outDir: outDirArg("runs"),
        port: { type: "string", description: "Serial port of the bridge's COM side." },
        cdpUrl: { type: "string", description: "Existing CDP endpoint; omit to open a temporary tunnel." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "deck_listGames",
    description:
      "List what deck_launchGame can reach, pressing nothing: the installed titles (name, appid, nonSteam -- true for a non-Steam shortcut), the Recent Games shelf's app ids in order, and RunningApps, all read over CDP from Steam's own state (collectionStore.allAppsCollection, SteamUIStore.RunningApps, the main window's route) with the same reads deck_launchGame makes. recentShelf is read only when the Home screen is up with the ring on a shelf tile (null otherwise, and recentShelfReason says why) -- that shelf read is device-unverified. notInstalledCount: how many library apps are not installed (not listed). Read-only: presses is always 0.",
    inputSchema: {
      type: "object" as const,
      properties: {
        cdpUrl: { type: "string", description: "Existing CDP endpoint; omit to open a temporary tunnel." },
      },
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
      "Report what Steam's gamepad nav graph actually owns on the connected Deck, read over CDP. Returns the gpfocus element and its gpfocuswithin ancestors, plus document.activeElement as a contrast field and an 'agree' flag - the two disagree often on Deck, and believing activeElement is what makes a focus fix look successful when nothing moved. Needs a Deck reachable over SSH with CEF debugging enabled; it opens and closes its own forward tunnel. This reads focus, it does not move it - to check that a press actually lands, press with the bridge and read focus before and after. timedOutPages: titles of pages that did not answer in time during this read (frozen pages, e.g. a hidden desktop window on a Windows stand-in); such a page gets only a short wait on the next read. slowestPageMs: the longest any page that was waited for took, in ms; a read returns as soon as the ring's page is known and does not wait for pages after it.",
    inputSchema: {
      type: "object" as const,
      properties: {
        cdpUrl: {
          type: "string",
          description:
            "Existing CDP endpoint, e.g. http://127.0.0.1:8080. Omit to open a temporary SSH forward to the configured Deck.",
        },
        timeoutMs: {
          type: "number",
          description:
            "Per-page Runtime.evaluate budget in ms (default 10000). Every listed page is asked at once, so a page that never answers costs the read one timeout, not one per page.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "deck_checkReady",
    description:
      "Diff a DECLARED Deck state against the ACTUAL one before a run starts, so a blind run fails at step zero with a named reason instead of burning a whole run on a sleeping Deck, a stale build, a foreign CDP tunnel, an unexpected game, an on-screen modal, or an unowned focus ring. Every field is optional -- an absent one is not checked at all -- and a check that could not be evaluated (an unreachable Deck, a reader that errors) reports 'unknown' rather than silently passing. Read-only: this presses nothing. `buildMatches` reuses the exact file set deck_deploy copies and compares sha256 hashes; the other checks read through readFocus/readPage/gameSession/killswitch, the same machinery those tools use.",
    inputSchema: {
      type: "object" as const,
      properties: {
        awake: {
          type: "boolean",
          description: "The Deck must (true) or must not (false) be reachable right now.",
        },
        buildMatches: {
          type: "boolean",
          description:
            "The build installed on the Deck must (true) or must not (false) have the same content hash as the local plugin's deploy sources (dist, main.py, plugin.json, etc). Uses pluginRoot/pluginName and the configured DECK_IP/DECK_USER.",
        },
        runningAppId: {
          type: ["number", "null"],
          description:
            "The Steam app id that must be the one running game, or null to declare that nothing should be running. Omit this field entirely to skip the check.",
        },
        pluginOpen: {
          type: "string",
          description: "Name of the plugin whose own panel must currently be open and on screen in the Quick Access Menu.",
        },
        noForeignCdpTunnel: {
          type: "boolean",
          description:
            "true to require no live CDP tunnel currently registered by a different process (e.g. another agent session already driving this Deck).",
        },
        modalOnScreen: {
          type: "boolean",
          description:
            "Whether a Steam modal dialog (e.g. the exit-game confirmation) should currently be on screen. Best-effort: only detects a modal that has captured the gamepad focus ring, the one shape this codebase has measured.",
        },
        focusRingOwned: {
          type: "boolean",
          description: "Whether Steam's gamepad focus ring should currently be owned by something.",
        },
        machineKind: {
          type: "string",
          enum: ["deck", "standin"],
          description:
            "The machine this call drives must be the real Deck ('deck') or a stand-in ('standin'). A run whose verdicts must only ever come from the real Deck declares 'deck' and fails at step zero on a stand-in.",
        },
        foreground: {
          type: "boolean",
          description:
            "Steam Big Picture must (true) or must not (false) be the foreground window, read from the 'Steam Big Picture Mode' page's visibilityState and hasFocus. Checked by default (as true) on a Windows machine, where Steam only takes pad input while Big Picture is in front; elsewhere only when declared. 'unknown' when that page cannot be read.",
        },
        pluginRoot: {
          type: "string",
          description: "Plugin workspace root, for buildMatches. Defaults to the detected workspace plugin.",
        },
        pluginName: {
          type: "string",
          description:
            "Deployed directory name (plugin.json's name, case intact), for buildMatches. Defaults to the detected plugin's name.",
        },
        rootSelector: {
          type: "string",
          description:
            "CSS selector for the plugin's own panel root, for a definitive pluginOpen check instead of inferring from Decky's pane labels. Defaults to panelRootSelector in .decky/preview.json.",
        },
        cdpUrl: {
          type: "string",
          description: "Existing CDP endpoint; omit to open a temporary tunnel for whichever checks need one.",
        },
        targetsSettleMs: {
          type: "number",
          description: "Upper bound on waiting for Steam's UI pages to be listed, e.g. right after a deploy restarts the loader. Default 10s.",
        },
        timeoutMs: { type: "number" },
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

  // ---- Deck: hold-awake and settings snapshot (session hygiene) ---------
  {
    name: "deck_holdAwake",
    description:
      "Stop the Deck falling asleep for the length of a QA run, by holding a systemd-logind " +
      "BLOCK inhibitor on sleep. Use it before a run with a lot of waiting -- slow replies, a " +
      "game launch, a person reading results -- where the Deck sleeping would swallow presses " +
      "and empty-read the rest rather than reveal a real defect. Measured on hardware " +
      "2026-09-08: Steam suspends through logind (SteamClient.System.SuspendPC()), and with " +
      "this lock held Steam is refused and says so itself -- 'Access denied due to active " +
      "block inhibitor'. NOTHING ON THE DECK IS MODIFIED: this is a lease, not a setting, so " +
      "there is no previous value to capture and nothing to put back, and every failure falls " +
      "toward the safe state -- if the lock is dropped, the host crashes, or the TTL runs out, " +
      "the Deck simply sleeps again. THE HOLD IS VERIFIED, NOT ASSUMED: the lock is read back " +
      "from systemd-inhibit --list and the matching line is returned as `evidence`. held:true " +
      "means a lock was actually seen; if the lock does not appear, this reports ok:false and " +
      "says the Deck can still sleep, rather than claiming a hold it never took. Call " +
      "deck_restorePowerSettings when the run ends; the TTL is a safety net, not the normal path.",
    inputSchema: {
      type: "object",
      properties: {
        ttlMinutes: {
          type: "number",
          default: 30,
          description:
            "Lease length. The lock releases itself after this many minutes if " +
            "deck_restorePowerSettings is never called. Clamped to 1..480.",
        },
        note: {
          type: "string",
          description:
            "Short reason, shown in the WHY column of systemd-inhibit --list on the Deck so a " +
            "human can see who took the lock. Filtered to a safe character set.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "deck_restorePowerSettings",
    description:
      "Release the wake lock deck_holdAwake took, so the Deck sleeps normally again. Despite the " +
      "name -- kept because a live consumer already calls it -- there are no settings to put " +
      "back: the hold is a logind inhibitor, so nothing on the Deck was ever changed. Safe to " +
      "call when nothing was held (a clean no-op, not an error) and safe to call twice. Like the " +
      "hold, the release is VERIFIED: the inhibitor list is read back, and a lock still present " +
      "after the stop is reported as ok:false rather than as a success -- a Deck that cannot " +
      "sleep is a battery problem somebody needs to hear about. Call this at the end of every " +
      "run that called deck_holdAwake; the TTL expiry is a safety net, not the normal path.",
    inputSchema: noArgs,
  },
  {
    name: "deck_sleepAndWake",
    description:
      "Put the real Deck to sleep, let it wake itself after `seconds`, and record where the focus ring was before " +
      "and where it is after -- for a bug that only shows after a sleep and wake. Runs only on kind 'deck' with os " +
      "steamos or bazzite; every stand-in, every Windows machine and a local server are refused before anything " +
      "else. Refuses, with nothing slept, when: seconds is under 45 or over 600; a game is running (RunningApps over " +
      "CDP AND the process list over SSH, as deck_exitGame asks; a check that could not be made is a refusal too); a " +
      "logind block inhibitor on sleep is held by anyone (logind would refuse the suspend -- deck_holdAwake's lock is " +
      "released with deck_restorePowerSettings); the killswitch is set. THE WAY BACK IS ARMED FIRST: `sudo -n rtcwake " +
      "-m no -s <seconds>` over SSH, then /sys/class/rtc/rtc0/wakealarm is read back and compared with the Deck's own " +
      "clock plus seconds (within 5 s); a failed or disagreeing read-back clears the alarm and refuses. Needs a " +
      "NOPASSWD sudo rule for the Deck's user, as deck_holdAwake does. Then the before state (focus, route, uptime -s, " +
      "the killswitch files on this PC) is written to runs/sleep-wake_<ts>.json BEFORE the suspend. The suspend is " +
      "SteamClient.System.SuspendPC() in SharedJSContext over CDP -- the call Steam's idle timer makes (measured " +
      "2026-09-08) -- reported as via 'steam-suspend-call', fidelity null: not a press. via 'power-menu' is accepted " +
      "and refuses as not implemented. SSH must stop answering within 30 s (else suspended:false, the alarm is " +
      "cleared, and it stops) and answer again within seconds + 60 s (else back:false: press the power button). On " +
      "the way back it opens a fresh CDP tunnel and reads focus WITHOUT pressing anything and WITHOUT opening the " +
      "panel; a ring that came back somewhere else is reported (focusMoved:true, focusReport), never fixed. The alarm " +
      "is cleared at the end whether or not it fired, read back, and ok is false if it could not be. Result: before / " +
      "after (focus with visibility, route, uptimeSince, killswitch), suspendedForMs and sshBackAfterMs (SSH probes, " +
      "2-3 s steps), alarmFired (best effort), alarmCleared, rebooted, journal (suspend and resume lines, best " +
      "effort), stages, runFile. Its deadline is seconds + 180 s; a shorter deadlineMs is refused. DEVICE-UNVERIFIED " +
      "as a whole: only the rtcwake arm/clear and the SuspendPC call were measured, separately.",
    inputSchema: {
      type: "object" as const,
      properties: {
        seconds: {
          type: "number",
          description:
            "How long the Deck sleeps before its RTC alarm wakes it: 45..600. Measured 2026-09-08: back on the network about 7 s after the resume.",
        },
        via: {
          type: "string",
          enum: ["steam-suspend-call", "power-menu"],
          default: "steam-suspend-call",
          description:
            "How the Deck is put to sleep. 'steam-suspend-call' is SteamClient.System.SuspendPC() over CDP. 'power-menu' is not built yet and refuses.",
        },
      },
      required: ["seconds"],
      additionalProperties: false,
    },
  },
  {
    name: "deck_snapshotSettings",
    description:
      "Copy the plugin's settings directory on the Deck (~/homebrew/settings/<name>), and " +
      "optionally its data directory (~/homebrew/data/<name>), into a local run file over SSH " +
      "before a test round changes anything. Replaces the hand-made settings.json.bak-preQA files " +
      "QA sessions have been leaving on the Deck. Refuses if an earlier snapshot from this tool " +
      "was never restored, naming when it was taken and pointing at deck_restoreSettings; it also " +
      "expires and restores itself automatically after ttlMinutes if nothing calls restore first. " +
      "The result says how it copied in `method` (\"buffered\" for a small folder, \"streamed\" when a big folder " +
      "is streamed straight to a file) with a one-line `methodNote`. A streamed copy is checked against the size and " +
      "checksum the Deck computed for what it sent; a short or damaged copy is taken once more, and if it is still " +
      "wrong the call fails with both sizes instead of reporting \"streamed\".",
    inputSchema: {
      type: "object",
      properties: {
        includeData: {
          type: "boolean",
          default: false,
          description: "Also snapshot ~/homebrew/data/<name>, not just the settings directory.",
        },
        ttlMinutes: {
          type: "number",
          default: 30,
          description: "Auto-restore after this many minutes if deck_restoreSettings is never called.",
        },
        note: { type: "string", description: "Freeform note recorded in the run file." },
        replace: {
          type: "boolean",
          default: false,
          description:
            "Instead of refusing over an unrestored earlier snapshot, set its run file aside under a dated name (kept, not restored) and take this one; the result names that file.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "deck_restoreSettings",
    description:
      "Put back exactly the settings (and data, if it was included) that deck_snapshotSettings " +
      "copied off the Deck, verifying the saved archive's checksum before sending anything so a " +
      "truncated or tampered run file is refused rather than pushed. Safe to call when nothing was " +
      "ever snapshotted (a clean no-op, not an error) and safe to call twice.",
    inputSchema: noArgs,
  },

  // ---- Studio: self-check -----------------------------------------------
  {
    name: "deck_runReport",
    description:
      "Read the run ledger and return the markdown block a testing row expects: one table row per call (tool, machine, build, verdict, evidence path) and a totals line. Read-only; takes no lease and presses nothing. The ledger is written by the server itself, one line per deck_* or plugin_* call (deck_status, deck_automationStatus and this tool are not recorded), under runs/ledger/<session>.ndjson, errors and deadline expiries included; with no arguments this reports THIS server's session. A verdict is \"the call returned ok\", NOT \"the row passed\": a fidelity of wire-sent is still only sent. The build column is the last deck_checkReady { buildMatches } answer this server got for that machine (and 'not read' when there was none in the last 30 minutes, or deck_deploy has run since); it is never read from the Deck for the report. Machine kinds are shown, and a report that includes a stand-in says so, so a stand-in's run is never filed as the Deck's. Pass the same rowId to the evidence tools (deck_sweep, deck_runSequence, deck_walkTo...) and to this tool to get one row's calls across sessions.",
    inputSchema: {
      type: "object" as const,
      properties: {
        session: {
          type: "string",
          description:
            "A ledger session id (the file name under runs/ledger/, e.g. 20261102T153012Z_pid4242, with or without .ndjson), or \"all\". Default: this server's own session, unless rowId or since is given, in which case every session is read.",
        },
        rowId: { type: "string", description: "Only the calls that carried this rowId, exactly." },
        since: {
          type: "string",
          description: "Only calls that started at or after this: an ISO date or time (2026-11-02T14:00:00Z) or a span back from now (30m, 2h, 1d).",
        },
        machine: { type: "string", description: "Only the calls on this machine name." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "studio_doctor",
    description:
      "Check Decky Plugin Studio itself for setup drift, without touching a Deck (the one serial status read described below touches the board, not the Deck). Returns a list of checks, each { name, ok: true | false | \"unknown\", saw, fix }, plus okCount, failCount and unknownCount; failures come first. Checks: the MCP config your IDE reads (.mcp.json, mcp.json, .cursor/mcp.json, .vscode/mcp.json) points at a server entry file that exists and is the same version as the extension; the four version pins agree (when the workspace is a DPS checkout); no other process holds the ingest port (the only port the server listens on); bridge/tools pad.py, chord.py and vpad.py and the capture scripts resolve from the running build, and Python can import serial (and vgamepad on Windows); machines.json parses and each machine has what its press transport needs; deck.env has DECK_IP and DECK_USER (absent is fine for a stand-in-only setup); the killswitch latch state; whether the run ledger folder (runs/ledger) can be written (the one check that makes a file: an empty one, removed again); and the bridge board's firmware, read with one `status` over its serial port when this machine presses through the board and no other session holds its lease (it presses nothing, and the check is \"unknown\" when the port is not free, the board does not answer, or the machine has no board). \"unknown\" means the check could not run (no Python, an unreadable file, a check that errored) and is never a pass. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        workspace: { type: "string", description: "Folder whose MCP config and version pins to check. Default: the server's workspace." },
        extensionVersion: { type: "string", description: "The extension's version, when the caller knows it. Default: read from extension/package.json, else the server's own." },
      },
      additionalProperties: false,
    },
  },

  {
    name: "studio_reportIssue",
    description:
      "File a Decky Plugin Studio issue (qd313/decky-plugin-studio) with a redacted diagnostic bundle, and never without showing you the text first. dryRun defaults to TRUE: nothing is posted, and you get back the exact markdown, its labels, a `confirmToken`, a prefilledUrl and whether `gh` is authenticated. Read the markdown. To post, call again with the same title, body and surface, dryRun: false and that confirmToken: it posts the text you were shown through `gh issue create` when gh is authenticated, else returns the prefilled new-issue link for a person to open and submit. A token this server did not issue, or one for different text, is refused. The bundle: versions (root, extension, server, SERVER_INFO), studio_doctor's result, the machine list as name, kind and os only, the last 20 lines of the newest runs/ledger/*.ndjson if one exists (else this server's own ring of its last 50 calls: tool, ok, duration, first error line), and the killswitch latch state. Redaction removes IPv4/IPv6 addresses, home and workspace paths, deck.env values (DECK_IP, DECK_USER), the OS user name, machine hosts from machines.json, email addresses and token shapes, from your prose as well as the bundle; it cannot catch what it was never told, so a person should read the markdown before approving a post. A failed tool call's error text carries a `[DPS report id: rXXXXXX]`; quote it in the body. Labels sent: surface:<surface> when given (deck, standin, extension, server) and source:agent or source:human; if the repo lacks a label the issue is posted without it and says so. Touches no Deck.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Issue title, up to 200 characters." },
        body: {
          type: "string",
          description: "What happened, what you expected, what you did, and any reportId quoted from an error. Up to 20000 characters; the diagnostic bundle is added under it.",
        },
        surface: {
          type: "string",
          enum: ["deck", "standin", "extension", "server"],
          description: "Where it went wrong: the real Deck, a stand-in, the editor extension, or this MCP server. Becomes the surface:* label. Omit if unsure.",
        },
        source: {
          type: "string",
          enum: ["agent", "human"],
          default: "agent",
          description: "Who is filing. Default agent. The editor command passes human.",
        },
        dryRun: {
          type: "boolean",
          default: true,
          description: "true (the default) returns the rendered issue and a confirmToken and posts nothing. false posts, and needs confirmToken.",
        },
        confirmToken: { type: "string", description: "The confirmToken from a dry run of the same title, body, surface and source. Required when dryRun is false." },
        extensionVersion: { type: "string", description: "The extension's version, when the caller knows it. Goes in the bundle." },
        workspace: { type: "string", description: "Folder whose MCP config studio_doctor checks. Default: the server's workspace." },
      },
      required: ["title", "body"],
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
];

/**
 * Every deck_* tool that drives or reads a machine takes `machine` (plan 10).
 * Added here, once, rather than typed into thirty-odd schemas by hand -- the
 * dispatch seam in index.ts is where the argument is read, also once. The
 * registry tools that take a machine NAME in their own right (deck_configure,
 * deck_releaseMachine, deck_stopAutomation) already declare it themselves.
 *
 * Schemas are cloned, not mutated: several tools share the `noArgs` object.
 */
const MACHINE_PARAM = {
  type: "string",
  description:
    "Which machine to drive: a name from deck_listMachines. Default: the registry default, normally 'deck' (the real Deck from deck.env). Every result carries `machine: { name, kind, os }` so a stand-in's verdict is never filed as the Deck's.",
};
for (const t of TOOLS) {
  if (!t.name.startsWith("deck_")) continue;
  if (Object.prototype.hasOwnProperty.call(t.inputSchema.properties, "machine")) continue;
  if (t.name === "deck_listMachines" || t.name === "deck_automationStatus") continue;
  // deck_runReport's `machine` is a filter on ledger lines, declared in its own schema.
  if (t.name === "deck_runReport") continue;
  t.inputSchema = {
    ...t.inputSchema,
    properties: { ...t.inputSchema.properties, machine: MACHINE_PARAM },
  };
}

/**
 * Every tool takes `deadlineMs` (plan 11, lane D). Described here, once; the
 * dispatch seam in index.ts reads it and strips it before the tool sees it.
 */
const DEADLINE_PARAM = {
  type: "number",
  description:
    "Wall-clock limit for this one call, in milliseconds. Defaults: 10 minutes for driving tools (press, walk, sweep, sequence, open, launch, exit, deploy, snapshot, record...), 30 s for deck_status and the registry/killswitch tools, 60 s for everything else. When it passes the call returns an error naming the tool, the deadline and the last stage it reported; child processes it started are killed and, for a driving tool, the pad is released (the stop latch is NOT set). A driving call that had to wait for an earlier one on the same machine counts the wait against this deadline, and its result says `waitedForPreviousCallMs`: how long it waited, in milliseconds, for the earlier driving call on that machine to finish.",
};
for (const t of TOOLS) {
  if (Object.prototype.hasOwnProperty.call(t.inputSchema.properties, "deadlineMs")) continue;
  t.inputSchema = {
    ...t.inputSchema,
    properties: { ...t.inputSchema.properties, deadlineMs: DEADLINE_PARAM },
  };
}

/**
 * Every deck_* and plugin_* call may carry a `rowId` (plan 12, lane C): the
 * testing row it belongs to. The dispatch seam copies it onto the call's ledger
 * line; the evidence-writing tools also write it into their file. Described
 * here, once. deck_runReport declares its own (a filter), and so does nothing
 * else: the seam strips it from a tool that does not use it.
 */
const ROW_ID_PARAM = {
  type: "string",
  description:
    "The testing row this call belongs to (for example P89-RIG-OPEN-AFTER-RELOAD). Recorded on the call's ledger line (see deck_runReport), and copied into the evidence file by the tools that write one. Never changes what the call does.",
};
const EVIDENCE_ROW_ID_PARAM = {
  type: "string",
  description:
    "The testing row this run belongs to. Copied into the evidence file and onto the call's ledger line (see deck_runReport).",
};
for (const t of TOOLS) {
  if (!t.name.startsWith("deck_") && !t.name.startsWith("plugin_")) continue;
  if (Object.prototype.hasOwnProperty.call(t.inputSchema.properties, "rowId")) continue;
  t.inputSchema = {
    ...t.inputSchema,
    properties: { ...t.inputSchema.properties, rowId: ROW_ID_PARAM },
  };
}

/**
 * `saveAs` on every tool that writes evidence: names the file (a file NAME:
 * anything before the last / or \ is dropped, odd characters become _, and the
 * real extension is kept). Per-tool text, because what the file is differs.
 */
const SAVE_AS_TEXT: Record<string, string> = {
  deck_sweep: "Name of the evidence file under runs/ (sanitised; .json added if missing). Wins over runName.",
  deck_runSequence:
    "Name of the evidence file under runs/ (sanitised; .json added if missing). Wins over runName, and asks for the file the way runName does (an unnamed run writes none).",
  deck_launchGame: "Name of the evidence file under runs/ (sanitised; .json added if missing). Wins over runName.",
  deck_exitGame: "Name of the evidence file under runs/ (sanitised; .json added if missing). Wins over runName.",
  deck_walkTo:
    "Write the result as runs/<saveAs>.json (sanitised) and return its path as evidenceFile, with rowId inside. Without it a walk writes no file.",
  deck_assertFocusMove:
    "Write the result as runs/<saveAs>.json (sanitised) and return its path as evidenceFile, with rowId inside. Without it a press-and-check writes no file.",
  deck_snapshotSettings:
    "Also write a small record of the snapshot (where the copy is, its size and checksum, rowId) as runs/<saveAs>.json. The archive itself keeps its own name, because deck_restoreSettings finds it through the snapshot's run file.",
  deck_captureScreenshot:
    "Name of the PNG under screenshots/ (sanitised; .png added if missing) instead of DeckCapture_<time>_<mode>.png. A picture cannot carry a rowId; it goes on the ledger line.",
  deck_record:
    "Name of the recording under recordings/ (sanitised; .mkv added if missing) instead of DeckRecord_<time>_<mode>.mkv. A video cannot carry a rowId; it goes on the ledger line.",
};
for (const t of TOOLS) {
  const text = SAVE_AS_TEXT[t.name];
  if (!text) continue;
  t.inputSchema = {
    ...t.inputSchema,
    properties: {
      ...t.inputSchema.properties,
      saveAs: { type: "string", description: text },
      // The evidence tools describe rowId in terms of their file.
      rowId: EVIDENCE_ROW_ID_PARAM,
    },
  };
}

export const TOOL_NAMES: ReadonlySet<string> = new Set(TOOLS.map((t) => t.name));

export function findTool(name: string): ToolDef | undefined {
  return TOOLS.find((t) => t.name === name);
}

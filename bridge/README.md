# deck-bridge — a Steam Deck the computer can actually press buttons on

An ESP32-S3 board that presents itself to a Steam Deck as a real USB game
controller, driven from a PC over a serial command channel. It closes the gap
named as finding **F1** in bonsAI's QA plan: nothing could press a button on the
Deck, so nothing could reproduce a D-pad bug, so focus bugs kept coming back.

Spike work for **plan 19 § 5, S1/S2** (bonsAI
`docs/planning/19-controller-macro-test-rig.md`); DPS-owned from the start per
that plan's decision **L1**.

## Layout

    firmware/deck_bridge/     the real firmware - JSON commands + watchdog
    firmware/spikes/          bring-up sketches, kept because they are diagnostics
    tools/                    PC side: flashing, driving, and measuring

## Quickstart

    cd tools
    .\flash.ps1 deck_bridge          # compile + flash over the COM port
    python pad.py status
    python pad.py press DOWN --ms 100
    python chord.py GUIDE A          # opens the Quick Access Menu
    python pad.py watchdog-test      # prove the safety net still fires

Needs `arduino-cli` with `esp32:esp32` and the `ArduinoJson` library, plus
Python with `pyserial`. Frame analysis additionally needs `ffmpeg`, `pillow`
and `numpy`.

## Status

Working: flashing, the command channel, the watchdog, the full button map, and
an unattended chord that opens the QAM.

**Not** working, and load-bearing: there is no machine verification of any of
it. Every result below was confirmed by a human looking at the Deck. Plan 19's
**L5** requires each macro step to be gated by a CDP state read keyed off
`gpfocus` markers; until that exists this is a rig that can press buttons, not
one that can tell you what happened.

## The board

YD-ESP32-S3 44-pin, ESP32-S3-WROOM-1 **N16R8**. Verified on hardware 2026-08-25:

    ESP32-S3 (QFN56) rev v0.2 | 16MB flash | 8MB PSRAM | BT 5 (LE)
    MAC 44:1b:f6:fe:67:84

Auto-reset over DTR/RTS works — flashing never needs the BOOT button held,
which is what makes unattended reflashing possible later.

## The two USB-C ports (this is the whole point of this board)

| Silkscreen | Chip path | Faces | Carries |
|---|---|---|---|
| **COM** | CH343P USB-UART, `VID_1A86 PID_55D3` | the **PC** | flashing + serial log + (later) the JSON command channel |
| **USB** | native USB OTG | the **Deck** | the HID gamepad |

Currently enumerates as **COM7**.

## Setup already done on this machine

- CH343 driver: already present, no install needed.
- `esptool` 5.3.1 via pip (`C:\Users\still\AppData\Roaming\Python\Python312\Scripts`).
- `arduino-cli` 1.5.2 portable at `C:\Users\still\tools\arduino-cli\` (no admin).
- Core `esp32:esp32@3.3.11` installed.

## Flashing

    .\flash.ps1 01_hello
    .\flash.ps1 02_gamepad_usb
    python read-log.py COM7 9      # read the serial log for 9 seconds

`flash.ps1` holds the FQBN and comments why each build option matters. The two
that are easy to get wrong: `USBMode=default` (means TinyUSB, required for HID)
and `CDCOnBoot=default` (means CDC *disabled*, keeps the log on the COM port).
Both Arduino option names read backwards from what they do.

## Sketches

- **01_hello** — prints chip info and a tick per second. Proves the board and
  the COM path work. Verified working.
- **02_gamepad_usb** — spike S1. Generic USB HID gamepad; walks the D-pad down
  twice then up twice, forever. No buttons, net zero movement, always returns to
  neutral — safe to leave running against the Deck UI. Compiles and runs;
  **not yet observed by a host** (native port was unplugged).

## Where this is going

S1 asks whether Steam accepts a *generic* HID pad. If it does not, the board has
to impersonate an Xbox 360 pad (XInput descriptor, Microsoft VID/PID) — a much
bigger job. S2 (the Guide-button chord that opens the QAM) tends to pass or fail
with S1, since a generic pad may expose no Guide button at all.

Not built yet: the JSON command parser and the **neutral-on-silence watchdog**
(plan 19, L6). Per that decision the watchdog ships in the same sitting as the
first remote press command — never after.

## S1 findings — PC half, 2026-08-25

Board's native port into a Windows PC. **Half of S1 passes, and the half that
does not is the half that matters.**

### Passes

Windows enumerated it with no driver and no prompting:

    HID-compliant game controller
    HID\VID_303A&PID_1001\...
    USB\VID_303A&PID_1001\441BF6FE6784      (serial == the chip MAC)

SDL 2.28.4 — the same layer Steam reads controllers through — sees
`ESP32S3_DEV`, **32 buttons, 1 hat, 6 axes**, and receives every press:

    [339.950] hat=(0,1)    UP pressed
    [340.031] hat=(0,0)    released      -> 81 ms held, firmware asked for 80
    [341.530] hat=(0,-1)   DOWN pressed  -> 1499 ms gap, firmware asked for 1500

**Timing fidelity is ~1 ms.** That matters more than it looks: S2's Guide chord
is a stack of commands with tuned Fire Start Delays, and the macro runner's
`wait` steps are only as trustworthy as the board's clock. This is good enough.

Hat direction confirmed: firmware `hat=5` -> SDL `(0,-1)` down, `hat=1` ->
`(0,1)` up. The mapping is right way up.

### The problem

    SDL game controller mapping: NO — raw joystick

SDL has no layout for this GUID, so it is an **unrecognized joystick, not a
recognized gamepad**. It has 32 numbered buttons and no named ones — no A, no B,
and **no Guide**. Guide is the button S2 needs, because it is what opens the QAM.

So the open question is no longer "does the board work" — it does. It is
**"will Steam bind a system action to a nameless button?"** Three outcomes,
cheapest first:

1. **Steam Input binds it anyway.** Steam has its own mapping layer above SDL and
   does let you configure unrecognized controllers. If a button can be bound to
   the Steam/QAM action, S2 is solved with zero firmware work. Test this first.
2. **Add a controller mapping** so Steam recognizes the layout (SDL mapping
   string / Steam's own per-controller config). Moderate work, no firmware change.
3. **XInput impersonation** — rebuild the USB descriptor as an Xbox 360 pad
   (VID `045E` PID `028E`, vendor-specific interface). Steam then recognizes it
   natively with a real Guide button. This is the outcome plan 19's S1 notes
   warned turns the spike into a session or two.

Nothing here is decided until the board touches the Deck. The PC test cannot
answer it, because Steam Input is not running on this PC.

## S1 findings — Deck half, 2026-08-25

### Steam accepts the board (the main S1 question)

Settings -> Controller lists it, with a gamepad icon, not a generic-device one:

    Espressif Systems ESP32S3_DEV        USB     [Details]

So **Steam's controller layer is more permissive than SDL's gamecontrollerdb**.
The PC-side "NO — raw joystick" result was a poor predictor of the Deck and the
pessimism it caused was wrong. Outcome 1 of the three-way fork, the cheap one.

Still unanswered: whether a **Guide/QAM binding** can be attached to a nameless
button. That is S2 and it needs the Details screen.

### The runaway, and what it was not

Sketch 02 (autonomous DOWN,DOWN,UP,UP) made the Deck scroll as if UP were held.

Theory tested and **rejected**: that TinyUSB's hat descriptor
(`LOGICAL_MIN(1) LOGICAL_MAX(8)`, no null state) made our centered value of 0
clamp to 1 = UP. Sketch 03 holds absolute neutral forever; the Deck **sits
still**. Centered is read as centered. The fault is in the presses, not the
rest state.

Cause still unknown. Note a confound present during that test: a **Google
Stadia Controller connected over Bluetooth**. It did not cause the runaway
(neutral would still have scrolled), but disconnect it before further input
tests so every input has exactly one source.

### Why sketch 04 exists

Sketches 02 and 03 were autonomous - they pressed on their own schedule, so no
single press could be isolated and every theory stayed a guess. 04 makes the
board inert until commanded, which turns debugging into a controlled experiment
and is also the P1 serial bridge the plan actually wants.

## Sketch 04 — the command channel (current firmware)

Board does nothing on boot. One JSON object per line in on COM, one JSON line
back out, so the PC verifies rather than assumes.

    cd tools
    python pad.py status
    python pad.py press DOWN --ms 200
    python pad.py press A B                # chord
    python pad.py hold DOWN --secs 3       # needs the 4 Hz heartbeat
    python pad.py release
    python pad.py watchdog-test            # prove the safety net fires

**Watchdog (L6) is in from the first press command**, as that decision requires:
750 ms of silence on the link and everything goes neutral. A short press needs
no heartbeat because the board's own timed release beats the watchdog; a hold
needs one, which is the point. Timed release is non-blocking, so the watchdog
stays live during a press.

Not yet done: `deck_pad*` MCP tools, the extension kill switch, BLE transport,
and S2's Guide chord.

## Watchdog verified on hardware, 2026-08-25

Plan 19 P1's acceptance line ("kill switch provably neutralizes mid-press"):

    -> {"t":"hold","b":["DOWN"]}
    <- {"ok":true,"t":"hold","dirs":2}                       held
    *** heartbeat cut ***
    <- {"event":"watchdog","detail":"link silent, neutralized"}
    <- {"ok":true,"t":"status","dirs":0}                     released itself

Held DOWN, lost the link, went neutral ~750 ms later with nothing on the PC
side telling it to.

Two bugs found and fixed while proving it:

1. **pad.py wrote to the serial port from two threads** (heartbeat + command),
   which on Windows raises `SerialTimeoutException`. One lock now owns every
   write. Worth remembering when the runner grows more concurrent senders.
2. **`status` reported `live` right after a trip**, because any incoming line
   cleared the flag before it could be read. A status field that under-reports
   a safety trip is the same lying-instrument class as P1-5's `activeElement`.
   The trip is now sticky until the next real press clears it.

`pad.py` also releases the pad in a `finally`, so a crashed runner cannot leave
a button held even before the watchdog notices.

## The right oracle: Test Device Inputs

Settings -> Controller -> ESP32S3_DEV -> Details exposes **Test Device Inputs**
and **Calibration & Advanced Settings**. The input tester shows what Steam
actually receives, per input, live. Use it instead of watching a menu scroll:
a scrolling menu conflates "did the press arrive", "did it repeat" and "did it
latch", and cannot tell them apart. The tester separates them.

## Presses verified good, 2026-08-25

With Steam's **Test Device Inputs** open, a single commanded press reads
correctly: `press DOWN --ms 80` lights D-pad down for a split second and returns
to rest. At neutral the tester reads **Left/Right Trigger 0, Left/Right Joystick
0,0** - every axis centered.

That kills both remaining theories for the sketch-02 runaway:

- hat null-state clamping (killed earlier by 03_neutral_hold)
- axes read as unsigned, so 0 = jammed (killed here; they read as centered)

Presses, releases, rest state and the 2 s hold + repeat rate (~4/s, Steam's own)
are all correct. **The board's input path is sound.** The original runaway cause
is still unexplained; a Google Stadia pad was connected over Bluetooth at the
time and is the leading suspect, but that is not proven either.

### Steam's controller model

The tester draws a **full Xbox-style pad** - D-pad, ABXY, two sticks, two
triggers, bumpers, and a **Guide button** - and offers **Setup Device Inputs**.
Header reads `Device Support: 303a-1001-1640a6a (0x303a,0x1001)`.

Steam also maps our buttons to standard positions, not anonymous numbers: a
stray **B press acted as Back** in the settings UI.

### Operational hazards found

1. **Resetting or reflashing the board closes Steam's input tester** (the
   controller drops out and Steam leaves the screen). Sequence any reflash
   *before* asking a human to open the tester, never between.
2. **Reflashing while connected to the Deck appears to inject ~2 s of phantom
   D-pad input.** A plain reset does *not*. Hypothesis: the ESP32-S3's ROM
   USB-Serial/JTAG device, which appears on the native port during download
   mode, shares VID:PID `0x303A:0x1001` with our HID gamepad - so Steam may keep
   the controller bound across the swap and parse serial bytes as gamepad
   reports. Unproven; the reset-vs-reflash asymmetry is the only evidence.
   **Rule regardless: unplug the Deck-side cable before reflashing.**

## Button map — measured, not guessed (2026-08-25)

**Steam's generic-HID button layout for this device**, found by pressing raw
bits 0-15 on a 2.0 s grid while recording Steam's input tester, then diffing
video frames against a resting baseline and taking the bounding box of whatever
lit up (`bitsweep.py` -> `runs.py`).

    bit  0 = A          bit  6 = LB         bit 12 = GUIDE
    bit  1 = B          bit  7 = RB         bit 13 = L3
    bit  3 = X          bit 10 = SELECT     bit 14 = R3
    bit  4 = Y          bit 11 = START      bits 2, 5, 8, 9, 15 unused

**The map is not dense.** Assuming consecutive bits is what put GUIDE on 8
instead of 12 and made five names look dead.

Cross-checked two ways. Under this map the earlier by-eye sweep should have
shown `Y, X, RB, LB, up, down, left, right, A, B`; the maintainer reported
`RB, LB, up, down, left, right, a, b` - the same sequence with the first two
presses missed. An independent observation agreeing is what made it safe to act
on.

### GUIDE exists — XInput is not needed

This is the S2 blocker removed. Earlier evidence (SDL has no mapping; five names
dead; no Guide) pointed at rewriting the USB descriptor to impersonate an Xbox
360 pad. **That work is now unnecessary**: Guide is reachable on bit 12, so the
QAM path in troubleshooting.md section 5 is open on plain generic HID.

Worth noting how close that call came to going the wrong way. Three independent
signals all said "XInput", and all three were artefacts of a wrong lookup table.

### Why the human eye was not enough

The maintainer reported 5 lit buttons; the video showed **11**. Every press was
600 ms and they came 2 s apart. No fault of the observer - it is the same reason
plan 21 argues the loop cannot depend on someone watching. The video was not a
convenience here, it changed the answer.

### Method notes for next time

- **Mask the status bar.** The clock and battery tick on their own and land in
  every bounding box. `runs.py` zeroes the top 20 rows of the scaled frame.
- **Pick the baseline from the middle of the recording**, not the start. Frames
  at t=0.5 s and t=3 s were unusable; t=60 s was clean.
- The clapper press was never detected, so alignment came from the 2.0 s grid
  plus a known-good anchor (bit 0 = A). A louder sync marker would be better -
  something that cannot be confused with screen settling.

## MILESTONE — QAM opened unattended (2026-08-25, 22:24)

    python chord.py GUIDE A
    1. hold GUIDE                 buttons:4096
    2. tap A while held           buttons:4097
    3. release A, keep GUIDE      buttons:4096
    4. release all                buttons:0

The Quick Access Menu opened with nobody touching the Deck. This is **step 2 of
the golden-path smoke** (plan 19 section 4) and the first primitive of the rig
working end to end.

Sent as overlapping HID reports - hold, then hold+tap, then hold, then neutral -
not one report with both bits set. That is what plan 19's `deck_padChord`
specifies and what a human chord looks like on the wire. It worked first try at
a 250 ms pre-hold, so no timing sweep was needed.

The QAM rail's bottom icon is **Decky**, one row below the Help tab that took
focus on open. Step 3 (walk to the bonsAI tab) starts from there.

### What is NOT done, and matters

**Verification is still a human looking at a screen.** Plan 19 L5 requires every
macro step to be gated by a CDP state read - `verify(state)` confirming the QAM
overlay is actually up, keyed off `gpfocus` markers rather than `activeElement`
(findings-log P1-5). None of that exists yet. Tonight proved the *press* half of
the loop; the *verify* half is still the maintainer's eyes, which is exactly the
instrument plan 21 says the loop cannot depend on.

So: the golden path is 1 step of 7, and the step that is done is unverified by
machine.

Also still missing before P1 is real: `deck_pad*` MCP tools, the extension kill
switch and status display, the stream/tee pipeline (S3), and BLE transport (L3).

## Verification policy

**Verify before every A press. Not before every D-pad move.**

A D-pad move is reversible and harmless - the worst case is the highlight
sitting somewhere unintended, which the next check catches. **A is the
commitment.** It is where "walking a menu you only believe you are in" turns
into activating something unknown, so that is the one place a check is
mandatory.

This keeps the rule that no macro may act on an unverified position, without
paying for a check on every keypress. The cheap pattern:

> Read the list **once** to compute the plan, execute the presses, verify
> **once** before committing.

Thirteen plugins in the Decky list means one live read plus one verify, not
thirteen screenshots. Verification overhead for a full run lands around 20-30
seconds rather than several minutes.

### Oracles return verdicts, not pictures

A check is **a program that returns a string**, never an image for a model to
interpret. `qam_tab=decky conf=0.98` is a few tokens; a screenshot is over a
thousand, and a nightly loop pays that on every step of every row.

Screenshots belong on disk. An image should reach a model's context only when a
check has **failed** and needs diagnosing, or when a human asked to see it.

This is not aspirational: mapping the button table analysed 1,273 frames and put
**four** images in front of a model, all four for calibration and for showing
the maintainer. The map itself came from a script printing bounding boxes.

### Which oracle answers which question

| Question | Oracle | Why |
|---|---|---|
| Which QAM tab is focused? Is the QAM open? Which plugin row is highlighted? | CDP if it can reach Steam's chrome, else a cropped screenshot | Fixed screen regions, large highlight areas, and it survives DOM reshuffles |
| What is the plugin's own focus state? | **CDP only** | A screenshot cannot distinguish `gpfocus` from `activeElement`, and that distinction is the entire content of bonsAI finding P1-5 |

Worth testing early: Steam's UI is CEF and Decky injects into the same context,
so CDP may be able to read the QAM rail directly. If it can, chrome checks
become free and instant and screenshots drop to a fallback.

### Scope

Steam's chrome and Decky's own plugin list are **generic** - every Decky
developer has the same QAM and the same loader list - so recognising them
belongs here. Anything inside a plugin belongs to that plugin's repo. Per plan
19 § 3, plugin-specific selectors never enter this tooling.

## Tools

| Tool | Does |
|---|---|
| `flash.ps1` | Compile + flash a sketch. Holds the FQBN and why each option matters. |
| `pad.py` | Drive the board: `status`, `press`, `hold`, `release`, `watchdog-test`. |
| `chord.py` | Hold one button, tap another. `chord.py GUIDE A` opens the QAM. |
| `sweep.py` | Press named buttons in turn, for watching which lights up. |
| `bitsweep.py` | Press raw bits 0-15 on a fixed 2.0 s grid, for mapping an unknown host. |
| `runs.py` | **The one that produced the button map.** Finds every lit event in a recording and reports its bounding box. |
| `analyze-sweep.py` | Same idea, keyed off a clapper marker instead of detected runs. |
| `diag-activity.py` | Dumps the per-frame activity profile. Reach for this when a recording will not align. |
| `watch-pad.py` | PC-side: watch what SDL receives from the board. |
| `check-mapping.py` | PC-side: does SDL have a controller mapping for this device, or is it a raw joystick? |
| `read-log.py` | Read the board's serial log for N seconds. Resets the board on open. |

**Use `runs.py`, not `analyze-sweep.py`, until the latter is fixed.**
`analyze-sweep.py` aligns frames by locating a clapperboard press, and on the
recording that produced the button map it never found one - the opening seconds
were swamped by the screen still settling. `runs.py` sidesteps alignment
entirely by reporting every event it detects with a timestamp, which is then
matched against the known 2.0 s grid by hand. That worked first time.

A louder sync marker would fix `analyze-sweep.py`; nothing yet needs it.

# Plan 08 — Parallel VM QA farm for bonsAI (planning only, not implementing)

**Raised 2026-09-05 by the maintainer.** Status: **UNSHELVED 2026-09-23 — see § 7.** (Was shelved
2026-09-05, blocked, see § 6.)
Nothing here is authorized for implementation. Discovery stopped after round 1 and its follow-ups;
rounds 2 and 3 were never asked. Resume from § 6 when the blocker moves.

**Star rating (GTA scale, effort/risk): ★★★★★★ as currently scoped** (VM verdict must equal a
Deck verdict, and no Steam login at all). Rough, from round 1 only. Two cheaper shapes are
priced in § 6.

---

## 1. The idea in one paragraph

Today one agent drives one real Steam Deck through one ESP32 bridge, one test row at a time.
The proposal: spin up several virtual machines running SteamOS (or Bazzite, or similar), each with
Decky and the bonsAI plugin installed, and let several subagents drain different bonsAI test rows
(from `bonsAI/docs/testing.md`) at the same time. Goal: save wall-clock time on device QA.

## 2. What we know going in (facts from the repos, before any answers)

**Host PC (measured 2026-09-05):** i7-12700K, 12 cores / 20 threads, 32 GB RAM, Radeon RX 9070 XT
(16 GB), 185 GB free on C:. Windows 11 **Home** — so **no Hyper-V**. No VirtualBox, VMware, or
QEMU installed today. WSL is present (not suitable: WSL2 cannot run gamescope / Steam Gaming Mode).

**Rough VM budget on that host:** a SteamOS VM that boots Gaming Mode wants ~4 GB RAM and 2-4
vCPUs. Leave ~8 GB and 4 threads for Windows, the MCP server, the agents and Ollama. That is
**3 VMs comfortable, 4-5 the ceiling**, before the host itself gets slow. The GPU is not shareable
across VMs on this setup (one card, and passing it through would take the host's display), so VMs
render in software; Ollama stays on the host GPU.

- bonsAI `testing.md` has about **115 distinct row IDs** across ~50 families (DRG-GLOSSARY 12,
  PICKER-REORDER 8, SHELL-PAYLOAD 6, ONBUTTONDOWN-AUDIT 6, COPY-REPLY 6, ...).
- The current rig talks to the Deck three ways: **SSH** (deploy, logs), a **CDP tunnel** (read
  focus, visibility oracle, waitFor), and the **ESP32 HID bridge on COM7** (button presses).
- Only **one ESP32 board** exists. It is a USB gamepad; it can only be plugged into one host.
- Maintainer constraints stated up front:
  - **No extra Steam accounts.** Not negotiable.
  - VMs should **not touch the internet or Steam**. LAN access for Ollama / knowledge base maybe.
  - This is for **parallel testing to save time**, nothing else.
- Maintainer questions to answer in this plan: how crazy is it; are Steam accounts needed; how
  many VMs before the host bogs down; is the single ESP32 a blocker; what model mix is
  token-efficient (Haiku for presses/waits, Sonnet for screenshots, Opus orchestrating) and what
  mix is better quality without "Fable for everything"; reasoning and context window considered.

## 3. Discovery log

### Round 1 — structure and scope (asked 2026-09-05, awaiting answers)

Questions asked:
1. What does "SteamOS in a VM" need to actually run for the rows you care about: the real Steam
   client in Gaming Mode (Big Picture / gamescope), or is a Decky-hosted plugin in a plain
   browser-like shell enough for most rows?
2. Which rows are you trying to parallelize: the focus/D-pad rows, the Ask/LLM rows, or all of
   them?
3. Is the target "several VMs on the one Windows PC that already runs the rig", or a separate
   box?
4. Is a real Deck still in the loop as the final gate, with the VMs as a first pass?

Answers (2026-09-05):
1. **Both kinds** — D-pad/focus rows and Ask/LLM rows.
2. **Depends how built it is.** Maintainer's expectation: a SteamOS VM with the backend fully
   built should be as reliable as a Deck, "but I could be wrong." (Agent's view recorded in
   § 4: same Steam UI code, so focus/DOM oracles should match; rendering and timing will not.)
3. **Same machine** — the Windows PC that already runs the rig.
4. **Not sure yet** where the no-Steam / no-internet line sits.

#### Round 1 follow-ups (asked 2026-09-05, awaiting answers)
a. Accept a split verdict? VM verdict counts for focus/oracle rows; real Deck still required
   for visual, timing, and hardware rows. Or run a one-VM spike first to measure agreement.
b. Steam login: is "log in once on a golden image, clone it N times, block the network"
   acceptable? That is one login total, with the single existing account.
c. Hypervisor: Windows 11 Home has no Hyper-V. VirtualBox, VMware Workstation (free for
   personal use), or QEMU? Any preference or past experience?
d. Ollama: the GPU is on the host, so one Ollama serves every VM over the virtual LAN. Ask rows
   then queue on one GPU. Acceptable?

Answers (2026-09-05):
a. **No split verdict.** The VM must handle whatever a real Deck can, or it is not worth having.
b. **Even one login is out.** No Steam account touches a VM, not even once on a golden image.
c. **No hypervisor preference.**
d. **Yes**, Ollama on the host, reached over the LAN.

Maintainer then shelved the plan: 'I think this is blocked for now.'

### Round 2 — less critical (never asked; shelved first)
Would have covered: model mix per role (see § 5), how rows are handed out and how verdicts are
merged, how a VM gets rebuilt between rows, what "done" looks like for a farm run.
### Round 3 — edge cases (never asked; shelved first)
Would have covered: a VM hanging mid-row, two VMs hitting the same Ollama model at once, the
killswitch across VMs, and how to tell a VM-only failure from a real bug.

## 4. Open risks noticed so far (to confirm with the maintainer)

- **Steam login without an account per VM.** Steam Gaming Mode wants a logged-in client. Offline
  mode needs one prior online login per install. One account logged in on several machines at
  once is a real problem for gameplay, but may be fine for a menu-only session. Needs checking.
- **The ESP32 is a physical USB device.** A VM can be given the USB device (passthrough), but only
  one VM at a time. Everything else would need a virtual gamepad instead (uinput / a virtual
  HID device inside each VM). That may actually be *better* for VMs than the real board.
- **Gamescope in a VM.** SteamOS Gaming Mode needs a GPU. Software rendering may work for menus
  but will be slow, and screenshots may look different from a real Deck.

## 5. Model mix (sketch only; round 2 never happened)

The maintainer's instinct is sound and worth keeping for whatever shape this ends up in:
- **Haiku** for the press-wait-read loop. Presses, `deck_waitFor`, and running a sequence file are
  string in, string out; the oracles already return text, not images. Small context, no
  reasoning needed.
- **Sonnet** for judging a row: reading the oracle output against the row's expected outcome,
  and any screenshot a row actually needs.
- **Opus** as orchestrator: picks rows, assigns them, merges verdicts, decides retries. It needs
  the long context (the whole testing.md section plus every verdict) and the reasoning.
- **Fable** only for the last step: turning confirmed failures into roadmap or issue text, where
  wording and judgement matter and volume is tiny.
Untested guess, to be checked in round 2 if this ever resumes.

## 6. Why it is shelved, and what would unblock it

**The blocker.** Answers a and b together are a contradiction on today's Steam. Steam's Gaming
Mode shell (the thing the focus rows test) will not start without a logged-in Steam client, and
a client cannot log in without an account touching the machine at least once. So "the VM does
everything a Deck does" and "no login ever" cannot both hold. There is no known way to run the
real Gaming Mode UI without an account.

**Three ways out, priced roughly:**
- **Relax b to one golden login.** Log in once on one VM image with the existing account, go
  offline, clone it, block the network. Unknowns: whether offline mode survives cloning, whether
  Steam objects to N offline copies. Roughly **★★★★★** (VM build, virtual gamepad per VM,
  software-rendered gamescope, orchestration, plus the spike to prove clones work).
- **Relax a to "Ask and backend rows only."** Plain Linux VMs (no Steam, no Decky UI) running
  the bonsAI backend against host Ollama. No login problem at all, and the rows that wait on
  the model are the slow ones anyway, so parallelism pays here. Roughly **★★★**. Focus rows stay
  on the real Deck.
- **Keep both a and b.** Nothing to build; stay shelved. **★★★★★★**.

**Things that are settled regardless of shape** (do not re-ask): same host; 3 VMs comfortable,
4-5 max on this PC; Ollama on the host GPU over the LAN; no hypervisor preference (Windows Home,
so VirtualBox / VMware Workstation / QEMU, not Hyper-V); the single ESP32 is not a real factor
because VMs would use a virtual gamepad instead.

## 7. Unshelved 2026-09-23: what changed

A new planning chat in bonsAI reopened this. The full plan now lives in bonsAI's plan 67
(`docs/planning/67-stand-in-decks.md` in the bonsAI repo): phases, decisions, and the PC's measured
budget. This section records only what moved and what DPS owns.

**Both halves of the § 6 blocker were relaxed, which is the first of § 6's three ways out:**
- **One Steam login per stand-in is now allowed.** Each stand-in signs in once with the one existing
  account, saves the password, and runs in Steam's offline mode from then on. Only one machine is
  ever online. The maintainer gets a warning before each sign-in. Whether a cloned stand-in keeps
  its offline sign-in is one of the things bonsAI's Phase 0 tests.
- **A split verdict is now accepted.** A stand-in doesn't have to do everything a Deck does. Rows
  needing a game, the hardware, the Deck's own Ollama timing, or Steam online stay on the real Deck.
  bonsAI's Phase 1 measures which kinds of row agree between a stand-in and the Deck.

**Other calls made 2026-09-23:**
- **Bazzite** on the stand-ins (the Deck edition, which boots into game mode). Heavier is fine.
- **Four stand-ins, tight**, three if four don't fit. Windows is to be squeezed to about 5 GB.
- **Stay on Windows 11 Home first** (Route A). If game mode won't run without a graphics card, a
  Linux dual boot is acceptable (Route B), where the stand-ins could share the RX 9070 XT.
- **Roles:** a *test lead* over several *rig leads*, one per machine (the real Deck included), each
  with *testers* under it. Models per role are still open. § 5's sketch is an input to that.
- **Two session styles:** every machine tests one build split between them, or each rig lead
  tests its own branch and the test lead merges.

**Measured on the host 2026-09-23 (differs from § 2):** WSL is no longer installed. Virtualization
is reported **off in the BIOS**, which blocks any VM until it is turned on. Windows reports the memory
at 2133 on a 3600 kit, which is being checked. 418 GB free on E:.

**What DPS has to build** (none of it before bonsAI's Phase 0 passes):
1. **A list of machines**, each with its address, and every `deck_*` call naming which one it drives.
   Or, as a stopgap, one MCP server per machine.
2. **Stand-in or real Deck**, reported by the tools, so a verdict always says where it came from.
3. **A virtual gamepad inside each stand-in** (uinput or similar). The ESP32 bridge on COM7 can only
   ever press buttons on one machine, as § 4 already noted.
4. ***Only one driver at a time*** (ROADMAP, Planned features), per machine, so two rig leads can
   never drive the same stand-in.

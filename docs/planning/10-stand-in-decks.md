# Plan 10 — Drive several Decks at once: stand-in Decks for bonsAI (discovery)

**Written 2026-10-05. Rounds 1 and 2 answered the same day; round 3 (§ 10) is awaiting answers.**
Planning only. Nothing built, nothing installed. The one action taken: the Bazzite deck ISO
(`bazzite-deck-stable-amd64.iso`, 9.6 GB) is in `E:\standins\` and its SHA-256 matches the published
checksum, verified 2026-10-05 (the maintainer said yes to the download in round 1).
Roadmap entry: *Drive several Decks at once: stand-in Decks for bonsAI* (★★★★★, Planned features).
Earlier record: [plan 08](08-parallel-vm-qa-farm.md) (why it was shelved, what moved). Consumer side:
bonsAI plan 67, `docs/planning/67-stand-in-decks.md` in the bonsAI repo.

This plan answers one question the maintainer asked on 2026-10-05: *are we ready to execute?*
Short answer: **no, four gates stand in front of the first line of DPS code**, and three of them are
not DPS work. Section 2 lists them. Section 6 says what can be automated so the maintainer's own time
is small. Section 4 holds the Steam agreement check the maintainer asked for. Section 3 now has a
fourth route, raised by the maintainer in round 2, that needs no BIOS change and no VM at all.

---

## 1. What was measured on the host today (2026-10-05)

Read-only. Differences from plan 67 § 4 (measured 2026-09-23) are marked.

| What | Found today | Means |
|---|---|---|
| Virtualization in firmware | **Still off** (`VirtualizationFirmwareEnabled: False`; VT-x and SLAT both supported by the chip) | Hard blocker for every VM route, VirtualBox on Windows and KVM on Linux alike. Only the maintainer can flip it. Route A″ (§ 3) does not need it. |
| Memory speed | 2133 on both sticks (configured and rated as Windows sees them). Same as 2026-09-23. | XMP is not on, or the BIOS is not applying it. Free speed, not a blocker. |
| BIOS | ASUS TUF GAMING Z690-PLUS WIFI D4, version 2204, dated 2022-11-29 | Old. Report only. Menu paths in § 7. |
| Hypervisor installed | None. VirtualBox, VMware, QEMU all absent. `wsl.exe` is only the Windows stub. | **winget can install VirtualBox 7.2.20 and QEMU 11.1.0 unattended. VMware Workstation is not in winget** (Broadcom account download, by hand). |
| Windows features that fight a hypervisor | Virtualization-based security: not enabled. Hypervisor not present. | Good. Nothing to turn off. |
| Memory in use right now | 19.5 GB of 31.7 GB. VS Code alone: 9.5 GB across eight windows. NordVPN 0.5 GB, Steam's web helper 0.4 GB. | Three 6 GB stand-ins need about 18 GB free: close most editor windows during a stand-in session. |
| Disks | E: is the 1 TB Crucial P5 Plus NVMe, 418 GB free, healthy. C: 119 GB free. D: 4.4 GB free. | E: fits the stand-ins at 60 GB each. NTFS, so a Linux boot can read the ISO from it too. |
| Network | LAN 192.168.86.27/24 on Ethernet. NordVPN **connected** (NordLynx tunnel up). The real Deck is at 192.168.86.52. | A NAT-networked VM reaches the host at a fixed address regardless of the VPN. **Prefer NAT plus port forwards** over bridged. |
| Ollama | 0.35.1, `OLLAMA_HOST=0.0.0.0`, listening on `[::]:11434`, inbound firewall allows for ollama.exe. No `OLLAMA_NUM_PARALLEL` / `MAX_LOADED_MODELS` / `KEEP_ALIVE` set. | Reachable from a VM as-is on Windows. The queueing knobs should be set before several clients share the card. On a Linux boot, Ollama has to exist on the Linux side too (§ 3). |
| Steam on the host PC | **Running, auto-login set** for the one account, games installed, online. | Already a third machine on the account alongside the Deck. Relevant to Route A″ and to § 4. |
| Bridge board | COM ports present today: COM1, COM3, COM5. **No COM7.** | Aside, not part of this plan: the board is unplugged or has moved ports. Presses on the real Deck will refuse until `DECK_BRIDGE_PORT` matches. |
| Bazzite install image | `bazzite-deck-stable-amd64.iso`, 9.6 GB (KDE). SHA-256 verified. | Ready in `E:\standins\`. |

## 2. The four gates, in order

1. **BIOS: virtualization on.** Maintainer's hands, about two minutes, one reboot. Needed for every
   VM route. Checklist in § 7. Not needed for Route A″.
2. **A hypervisor installed.** Automatable after gate 1. VirtualBox on Windows (decided, round 1);
   QEMU/KVM if the Linux boot is used (§ 3 says why VirtualBox gains nothing there).
3. **Phase 0 passes: one stand-in runs Steam's gamepad UI at all**, with bonsAI in its Quick Access
   Menu and a D-pad walk that moves the ring. Section 3 has the routes.
4. ***Only one driver at a time*** (ROADMAP, Planned). Not built. Round 1 decided it is built first.

**Why plan 67's "controller rig first" order is not a technical dependency (round 1, question 1).**
The controller rig (bonsAI plan 19) is the ESP32 board that presses the *real* Deck's buttons. Its four
unfinished pieces (a recording that is also a live view, checking the highlight from video, Bluetooth
handheld runs, the nightly unattended run) are all about trusting one real Deck's results with nobody
watching. A stand-in never touches that board: the board is USB, it can only be plugged into one
machine, and that machine stays the real Deck. What a stand-in needs is an *equivalent* of the rig,
and that is the virtual gamepad in § 5 item 4 (or a second board, § 3 Route A″). So nothing in the rig
has to finish before stand-in work starts, and nothing in stand-in work changes the rig. bonsAI's
2026-09-24 ordering was a priority call about where the maintainer's attention goes, not a blocker.
The two run in parallel.

## 3. Routes to a working stand-in

**The fact every fallback rests on** (bonsAI `docs/development.md` § on the dev loop, and confirmed
by Decky's own design): Decky injects into Steam's **gamepadui** layer, which is the same React/CEF
surface in Gaming Mode and in **Big Picture Mode**. The classic desktop Steam window has no Quick
Access Menu and no Decky; Big Picture does. bonsAI already documents a desktop-mode dev loop on the
Deck that goes Konsole → Big Picture → Quick Access Menu → bonsAI. gamescope is not part of what
bonsAI draws into; it is the part that needs a GPU.

**Route A: Windows host, VirtualBox, Bazzite deck image booting into game mode.** Decided as the first
VM try in round 1. Evidence gathered 2026-10-05: Bazzite's own documentation says nothing about VMs.
Community reports in VirtualBox and VMware are black screens and "super laggy"; none shows the Deck UI
usable. Mechanically, gamescope needs a KMS display device and a Vulkan device, and every hypervisor on
a Windows host gives the guest at most OpenGL acceleration, so the only Vulkan inside the guest is
Mesa's software driver (lavapipe). gamescope on software Vulkan is a known trouble spot on its own
issue tracker. **Honest read: a coin flip at best.** Still worth the afternoon: the ISO, the install
steps, the provisioning script, the virtual pad and every line of DPS code carry over.

**Route A′: same VM, Steam Big Picture in Bazzite's desktop, no gamescope.** If game mode will not
start, boot the same VM into desktop mode and run Big Picture there, exactly as bonsAI's dev loop does
on the Deck. Steam's browser draws the Quick Access Menu fine on a software renderer. What differs: no
gamescope, so game-mode-only behaviours (overlay over a running game, the performance menu) are
absent; Phase 1 sorts those into "Deck only" anyway. Decky upstream closed its "support Big Picture on
desktop Linux" request as done in 2023; the one limit reported there was the menu vanishing over a
running game, which stand-ins never do.

**Route A″ (maintainer, round 2): this Windows PC is stand-in number one. No VM.** Steam on Windows in
Big Picture Mode with a Windows build of Decky Loader. Facts found 2026-10-05:
- Upstream Decky Loader has **no official Windows support**. Three community projects exist. The
  usual one is *Decky-Loader-For-Windows* (ACCESS-DENIIED): a one-click installer that runs Steam with
  the `-dev` argument and autostarts PluginLoader; nine plugins confirmed working (CSS Loader,
  SteamGridDB and others); it calls itself experimental and "not affiliated". A second is a fork of
  upstream aimed at Big Picture on Windows (zavaro). Maintenance of either is unclear.
- **bonsAI's backend is not a stranger to Windows.** Its Python has `sys.platform` branches in the
  local-Ollama setup and teardown, plugin-data reset and Ollama-stop services, and its roadmap records
  that "the Python side ran on a Windows PC and all nine calls came back working" for another item.
  Known Linux-only pieces: the clipboard service (`wl-copy`), local-Ollama install (a Deck-only row by
  plan 67 anyway), Proton log reading. Gaps found in Phase 0″ are bonsAI's to fix or mark Deck-only.
- **Reading focus works without a tunnel:** Steam's CEF debugging answers on `127.0.0.1:8080` on this
  PC once Decky runs it with `-dev`, which is the same port the Deck tunnel forwards to today.
- **Pressing needs a controller the PC can see.** Windows has no uinput. Two options:
  **(a) a second YD-ESP32-S3 N16R8 board** (the exact board the rig uses, about the price of lunch),
  flashed with the existing firmware by `flash.ps1`, with *both* USB-C leads plugged into this PC: the
  PC then sees one controller and one COM port, DPS already speaks that transport, and the machine
  entry just names a different port. Known-good, measured on hardware, no driver questions.
  **(b) a software pad** through ViGEmBus 1.22.0 (last release November 2023; the project is archived
  over a trademark dispute but still installs and works on Windows 11) driven by Python `vgamepad`.
  Zero hardware, but it rests on an abandoned kernel driver. **Recommendation: (a).**
- **Deploy** is a copy into the Windows Decky plugins folder (location confirmed at install) and a
  PluginLoader restart; no SSH. The registry's `local: true` for this machine routes all of that.
- **Fidelity caveats, to measure in Phase 1:** a Windows Steam client build is not the SteamOS build
  (same gamepadui code, different release cadence), there is no gamescope, and the machine is not a
  Deck as far as Steam's "is this a Deck" check goes (plan 67 § 11 already lists what that changes).
- **Agreement caveat (§ 4):** this PC's Steam is the maintainer's gaming client, online, with games
  installed. The stand-in rules say offline and no games during automated runs. So: Steam on this PC
  goes to offline mode for the duration of a run, and nothing automated launches a game here.
- **Why it is attractive:** it needs no BIOS change, no hypervisor, no ISO and no sign-in; it could be
  the first lane to start; and it gives the "two machines for v1" the maintainer asked for (the Deck
  and this PC) while the VM routes are still being proven.

**Route B: Linux boot from the maintainer's separate Bazzite SSD, QEMU/KVM with virtio-gpu Venus.**
Decided acceptable in round 1; details confirmed in round 2: the SSD holds the **Bazzite deck image**,
already boots on this PC, is currently unplugged, has a user account, and needs Claude Code (plus
Node 20 for this repo's MCP server, and clones of both repos). This is the only route where stand-ins
get real Vulkan: Venus hands each VM Vulkan 1.3 backed by the host's RX 9070 XT, shared across all of
them at once. Facts:
- Host needs kernel ≥ 6.13 with `CONFIG_UDMABUF`, QEMU ≥ 9.2, virglrenderer with Venus, Mesa ≥ 24.2.
  Current Bazzite meets all four. Bazzite has `ujust setup-virtualization` (virt-manager Flatpak,
  libvirt group, kernel args); on some Bazzite versions `qemu-kvm` and `libvirt` must be layered with
  `rpm-ostree install` first.
- **Venus is not in virt-manager yet.** It needs QEMU on the command line:
  `-device virtio-vga-gl,hostmem=4G,blob=true,venus=true -display gtk,gl=on`. Every VM therefore has
  a window on the host desktop (accepted, round 2).
- **VirtualBox gains nothing on Linux.** It has no Venus. Route B means QEMU/KVM.
- **Ollama moves too** (accepted, round 2). Ollama on Linux needs ROCm 7.2 or newer for the RX 9070 XT
  (gfx1201), which lists it as supported with no overrides. Models are pulled again on the Linux side
  (about 45 GB for the current set).
- **The real Deck's bridge works from Linux**: `pad.py` takes any port string, so
  `DECK_BRIDGE_PORT=/dev/ttyACM0` in `deck.env` replaces `COM7`.
- **A trap in this repo, to fix as part of the registry work:** about fifteen call sites
  (`isLocalSteamOS()`, `detectLocalSteamOs()`, `isDeckLocal()` in `tools/deck.ts`,
  `tools/deckAutonomy.ts`, `tools/plugin.ts`, `tools/captureOrchestrator.ts`, `deploy/local.ts`) read
  "this process is running on Bazzite" as "this process is running *on the Deck*": tunnels are
  skipped, deploys go to the local `~/homebrew/plugins`, and the local Steam is read. A DPS server on a
  Bazzite host would deploy bonsAI into the host's own Decky folder. With a machine registry, "local"
  must come from the machine entry, never from the host's `/etc/os-release`.

**Order decided in round 2:** A″ can start at once; A then A′ on Windows as soon as the BIOS is done;
B when A and A′ fail or are too slow, or when more than one VM is wanted with real graphics.

## 4. The Steam Subscriber Agreement check (asked in round 1; accepted in round 2)

Read 2026-10-05 from `store.steampowered.com/subscriber_agreement`, last revised 2026-09-10. Quotes
are the agreement's words; the reading under them is mine, and it is not legal advice.

**What the agreement says:**
- **§ 4.C Automation:** "You may not use any form of scripts, bots, macros, or other
  non-human-controlled systems ('Automation') to interact with Content and Services on Steam in any
  manner, including but not limited to: Automating the Steam account creation process, Faking
  gameplay statistics (e.g., inflated wins or losses, XP, playtime), Earning rewards or progress
  without genuine user input, Participating in adjudication systems (like peer reviews or
  'overwatch') through automated means."
- **§ 4.B Cheating:** "You agree that you will not tamper with the execution of Steam or Content and
  Services unless otherwise authorized by Valve. You may not use Cheats, mods, hacks, or any other
  unauthorized third-party software, to modify any Subscription Marketplace process, the process of
  Steam account creation or otherwise in interacting with or controlling the processes or user
  interface of Steam Content and Services."
- **§ 1.C Your Account:** "strictly personal. You may therefore not sell or charge others for the right
  to use your Account, or otherwise transfer your Account."
- **§ 2.A:** the licence is "for your personal, non-commercial use". **§ 2.C Developer Tools:** content
  made with them may be distributed "solely on a non-commercial basis". bonsAI is Apache-2.0 and
  unpaid, so this is met.
- **No clause** mentions virtual machines, offline mode, or signing in on several devices. Steam
  Support's own FAQ: you may be signed in on many devices; you may *play* on one at a time. (So plan
  67's "signing a stand-in in takes Steam from the Deck" is not how current Steam behaves. Each new
  machine does need a Steam Guard approval from the mobile app, once.)

**Where the project's use sits against those words, plainly:**
- The letter of § 4.C covers any non-human-controlled interaction with Steam "in any manner". A script
  that presses D-pad buttons in Steam's Quick Access Menu is inside that letter. The four examples the
  clause gives are all about gaining something from Steam (accounts, stats, rewards, reviews); this
  project gains nothing from Steam: it presses a plugin's own menu to test the plugin.
- § 4.B's "tamper with the execution of Steam" is already engaged by Decky Loader itself, which bonsAI
  has depended on since the project began. Public record shows no documented case of Valve acting
  against an account for Decky Loader; Valve tolerates it and keeps desktop mode open.
- The real-Deck rig has pressed buttons through a hardware controller emulator since August 2026.
  To Steam that is a controller. A uinput virtual pad inside a stand-in is the same mechanism Steam
  Input uses to create its own virtual controllers. The stand-ins add VMs and offline mode, neither of
  which the agreement restricts.
- **What would actually raise the risk** and is therefore ruled out on stand-ins: running games
  (playtime, achievements), anything touching the store, market, community, reviews or trading, any
  automation of sign-in or Steam Guard, and many sign-ins in a short time.

**Rules for the stand-ins (adopted by the maintainer, round 2):**
1. Stand-ins run in offline mode; only one machine is ever online. Sign-ins are by the maintainer's
   hand, with the warning first, one stand-in at a time, spaced out. On Route A″, this PC's Steam goes
   to offline mode for the duration of an automated run.
2. No games on stand-ins. No store, market, community, reviews, inventory or trading, ever, on any
   automated machine.
3. Automation presses only the plugin's own UI and Steam's navigation to reach it, exactly as the
   real-Deck rig does today.
4. Nothing automated ever creates, modifies or signs into an account.

**What Steam sees when a stand-in signs in (maintainer's question, round 2).** Steam records the
machine as a device on the account: its hostname, operating system, approximate location from the
address, and last use, listed under Settings → Security → authorized devices, and the Steam Guard
prompt on the phone shows the same hostname and OS. The client can also read the hardware: in a VM
the board vendor says VirtualBox or QEMU, the GPU says "VirtualBox Graphics Adapter", "virtio-gpu" or
"llvmpipe", and the processor advertises a hypervisor. **So yes, Valve could tell it is a VM by looking,
and nothing here hides that.** Hiding it (spoofing the board name to read "Jupiter" so Steam thinks it
is a Deck) is exactly the kind of thing § 4.B is about and is ruled out. VM detection is an anti-cheat
concern for online games, which stand-ins never run. Practical consequence: give stand-ins honest
hostnames (`standin-1`, `standin-2`, `standin-3`) so they are recognisable in the device list and can
be removed from the account when retired.

## 5. What DPS builds (design sketch, confirmed in rounds 1 and 2)

The code today reads one machine from `deck.env` in about 50 places (`DECK_IP` / `DECK_USER`
across `tools/deck.ts`, `tools/deckAutonomy.ts`, `cdpTunnel.ts`, `holdAwake.ts`,
`settingsSnapshot.ts`, `checkReady.ts`). The press path spawns `bridge/tools/pad.py` on a serial
port. The CDP tunnel is already cached per `user@host`, so it needs no change to serve several
machines.

1. **Lease per machine first** (*Only one driver at a time*), at the dispatch seam in `index.ts`, with
   owner, purpose, expiry and heartbeat; the status poll stays off a leased port; the killswitch gains
   a per-machine stop beside stop-all.
2. **A machine registry.** `~/.config/decky-plugin-studio/machines.json`: for each machine a name,
   `kind` (`deck` or `standin`), `os` (`steamos`, `bazzite`, `windows`), `local: true|false`
   (replacing every `/etc/os-release` guess), host, SSH user and port (remote only), a press transport
   (`bridge` with its serial port, or `uinput`), a CDP port, an ingest port, and for a VM the
   hypervisor's VM name. `deck.env` keeps working as the machine named `deck`, so bonsAI's existing
   calls do not break. Route A″'s entry is `kind: standin, os: windows, local: true, press: bridge`.
3. **`machine` on every `deck_*` call**, default `deck`, resolved once at the dispatch seam, not inside
   each tool. Plus `deck_listMachines`, and `machine` on `deck_configure`.
4. **A virtual gamepad in each Linux stand-in.** A dependency-free Python script on the guest that
   opens `/dev/uinput` through `ctypes` and presents an Xbox 360 class pad (Steam's udev rules grant
   the seat user access to uinput, and that grant is per user, so an SSH session as the same user gets
   it too). Driven over the shared SSH connection; `pressButton` grows a second delivery beside the
   bridge one. Fidelity keeps its meaning: `wire-sent` means the guest acked the uinput write and
   nothing more; `verify: true` still earns `steam-routed` by reading focus before and after. Built
   *for* Phase 0 so no human holds a controller. On Windows (Route A″) the second bridge board or the
   ViGEm pad plays this part.
5. **Every result says where it came from.** A `machine: { name, kind, os }` field on every `deck_*`
   result; `deck_status`, `deck_getEnv` and `deck_checkReady` report it, and `checkReady` can require
   a kind, so a stand-in verdict can never be filed as a Deck verdict by accident.
6. **Host scripts under `scripts/standin/`:** install the hypervisor (winget on Windows; `ujust` plus
   `rpm-ostree` on Bazzite), verify the ISO against its checksum, create a VM (EFI, 4 vCPU, 6 GB,
   60 GB disk, 1280×800, 3D acceleration on, NAT with port forwards for SSH and CDP), provision over
   SSH (`ujust setup-decky`, point the plugin at the host's Ollama, deploy bonsAI, install the virtual
   pad), measure (memory idle and with bonsAI open, menu and D-pad latency through CDP), snapshot and
   restore a clean state, clone. Plus a Linux-host setup script for the Bazzite SSD (Claude Code,
   Node, both repos, virtualization, a Venus self-check) and a Windows Decky setup note for Route A″.

What stays manual, by nature: the BIOS, clicking through the Bazzite installer once per image,
`ujust toggle-ssh` typed once in the guest's desktop terminal, each stand-in's Steam sign-in with its
Steam Guard approval, and switching this PC's Steam to offline mode before a Route A″ run.

## 6. Lanes, once the maintainer says go

| Lane | Needs first | What happens | Whose hands |
|---|---|---|---|
| **L1: this PC as stand-in (Route A″)** | nothing | Windows Decky installed into this PC's Steam; bonsAI deployed; CDP read on 127.0.0.1:8080; presses through the second board or ViGEm; first Phase 0″ walk | DPS session; maintainer installs the Windows Decky (one click) and, if (a), plugs in the second board |
| **L2: lease, then registry and `machine`** | nothing | Code at the dispatch seam, tests at the desk, bonsAI's calls unchanged by default | DPS session |
| **L3: VM Phase 0 (Route A, then A′)** | BIOS (§ 7) | VirtualBox, VM, Bazzite install, provisioning, sign-in, measurements, pass/fail | DPS session; maintainer: BIOS, installer clicks, `ujust toggle-ssh`, sign-in |
| **L4: Linux host (Route B)** | L3 fails or more VMs with real graphics wanted | Plug the SSD, boot, run the host setup script, QEMU/KVM with Venus, same VM image | Maintainer: plug and boot, an evening to settle in; DPS session the rest |

L1 and L2 touch different files and run in parallel. L3 waits only on the BIOS.

## 7. The BIOS checklist (ASUS TUF GAMING Z690-PLUS WIFI D4, BIOS 2204)

1. Restart and press **Delete** during the ASUS logo. EZ Mode opens. Press **F7** for Advanced Mode.
2. **Advanced → CPU Configuration → Intel (VMX) Virtualization Technology → Enabled.** *Needed.* This
   is the one that blocks every VM.
3. **Advanced → System Agent (SA) Configuration → VT-d → Enabled.** *Nice to have.* VirtualBox does
   not need it; KVM device passthrough would. Harmless on.
4. **Ai Tweaker → Ai Overclock Tuner → XMP I.** *Nice to have.* Runs the memory at its rated 3600
   instead of 2133. If the PC later fails to boot or blue-screens, set it back to Auto; that is the
   whole risk.
5. **F10**, confirm, reboot.

Afterwards a DPS session verifies from Windows: `systeminfo` shows "Virtualization Enabled In
Firmware: Yes", and the memory reads 3600.

## 8. Round 1: asked and answered 2026-10-05

| # | Question | Answer |
|---|---|---|
| 1 | Order against bonsAI's "controller rig first" | Maintainer asked for the dependency to be explained; see § 2. Start now, in parallel. |
| 2 | Who runs Phase 0 | DPS owns the stand-in build scripts and runs Phase 0 from this repo. |
| 3 | Hypervisor | VirtualBox (Windows). QEMU/KVM if the Linux boot is used. |
| 4 | Route B appetite | Yes. The maintainer has a separate SSD with Bazzite that can be plugged in. |
| 5 | Virtual pad in Phase 0 | Yes. No physical controller and no human in the loop; the point is automated bonsAI testing. |
| 6 | Addressing | `machine` parameter with a registry, `deck` as the default. |
| 7 | Lease first | Yes, build *Only one driver at a time* first. |
| 8 | Steam Guard | Mobile app. |
| 9 | Three or four | Three for now. |
| 10 | Download now | Yes. Done and verified. |
| + | New ask | Check the Steam Subscriber Agreement. Done, § 4. |

## 9. Round 2: asked and answered 2026-10-05

| # | Question | Answer |
|---|---|---|
| 1 | Route order | Route A on Windows first. The maintainer raised Decky on Windows: if nothing else works, this PC becomes stand-in number one, and v1 runs on two machines (the Deck and this PC). Recorded as Route A″, § 3. |
| 2 | The Bazzite SSD | Deck image. Boots on this PC. Unplugged now. Has a user account. Needs Claude Code. |
| 3 | Linux sessions | Yes. |
| 4 | The agreement | Proceed; the four rules are adopted; account setup is the maintainer's hands. Asked what Steam would see and whether it can tell it is a VM: answered in § 4. |
| 5 | VM windows | Yes. |
| 6 | What "go" starts first | Maintainer pointed out the BIOS comes first. Correct for the VM lanes; § 6 shows which lanes wait on it and which do not. |

## 10. Round 3: asked and answered 2026-10-05

| # | Question | Answer |
|---|---|---|
| 1 | Presses on this PC (Route A″): second board or ViGEm software pad | **No spare board exists.** Resolution proposed below. |
| 2 | This PC's Steam offline during automated runs, no game launched by automation here | Agreed. |
| 3 | "Go" covers L1, L2 and L3, with L3 waiting on the BIOS | Agreed. |

**Presses on this PC, resolved as "both, in order":** start with the **ViGEm software pad** so L1 can
begin the day go is given (ViGEmBus 1.22.0 installer, a signed kernel driver, needs one admin
approval; Python `vgamepad` on top), and **order one YD-ESP32-S3 N16R8** (the rig's exact board, a few
days' shipping) as the durable transport. The machine entry's press transport is one field, so
swapping ViGEm for the board later is a config change, not code. Written as the default; the
maintainer can strike either half.

**Status after round 3: every decision is made. Nothing starts until the maintainer says "go".**
What go starts, concretely:
- **L1, this PC as stand-in:** ViGEmBus install (maintainer approves the admin prompt), a `vigem`
  press delivery beside the bridge one, the Windows Decky installer run by the maintainer (one click),
  bonsAI deployed into it, focus read on `127.0.0.1:8080` with no tunnel, first Phase 0″ D-pad walk
  with the result labelled `standin / windows`.
- **L2, lease then registry:** the per-machine lease at the dispatch seam, the status poll kept off a
  leased port, then `machines.json`, the `machine` parameter, `deck_listMachines`, the
  `machine: { name, kind, os }` field on every result, and the `/etc/os-release` trap replaced by the
  entry's `local` flag.
- **L3, VM Phase 0:** only after the BIOS checklist in § 7: VirtualBox by winget, the VM from the
  verified ISO, the uinput pad, provisioning over SSH, the maintainer's sign-in, measurements.

## 11. Not re-asked (settled in plan 08 § 6 and plan 67 § 3)

Same host; Bazzite deck image; Ollama on the host GPU over the network; the single bridge board is
not a factor because stand-ins use a virtual pad; split verdicts are accepted; one Steam account,
offline on every stand-in; no games on stand-ins in version one.

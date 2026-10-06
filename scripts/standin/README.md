# Stand-in Decks: host and guest scripts

Plan: `docs/planning/10-stand-in-decks.md`. Server side: `mcp-server/src/machines.ts`
(the registry), `mcp-server/src/deck/lease.ts` (one driver per machine),
`bridge/tools/vpad.py` (the virtual gamepad a stand-in presses with).

Every DPS `deck_*` tool takes `machine: "<name>"`. `deck_listMachines` shows the names.
Without it, `deck` -- the real Deck from `deck.env` -- as before.

| Script | Runs on | Does |
|---|---|---|
| `windows/setup-decky-windows.ps1` | this PC | Route A″: Decky Loader for Windows into this PC's Steam, homebrew folders, autostart, `machines.json` entry `this-pc`. Says when Steam needs a restart. |
| `windows/start-vpad.ps1 [-AtLogon]` | this PC | the ViGEm virtual controller daemon (`vpad.py serve`) on 127.0.0.1:7690 |
| `vm/install-virtualbox.ps1` | this PC | VirtualBox via winget (one admin prompt) and the two checks that make it slow (Windows' own hypervisor / Memory Integrity) or impossible (VT-x) |
| `vm/verify-iso.ps1 -Iso ...` | this PC | SHA-256 against the published `-CHECKSUM` file |
| `vm/create-vm.ps1 -Name standin-1` | this PC | the VM (EFI, 4 vCPU, 6 GB, 60 GB, NAT + SSH forward), its `~/.ssh/config` alias, its registry entry; starts the installer |
| `vm/provision.ps1 -Name standin-1` | this PC → guest | SSH key, `ujust setup-decky`, CEF flag, the virtual pad service, host Ollama endpoint, a report |
| `vm/measure.ps1 -Name standin-1` | this PC | memory, CDP round trip, press-to-focus latency |
| `vm/snapshot.ps1` | this PC | take / restore / list / clone |
| `guest/install-vpad.sh`, `guest/dps-vpad.service` | guest | the virtual pad as a user service (copied in by provision) |
| `linux-host/setup-bazzite-host.sh` | the Bazzite SSD | Route B host: virtualization, the Venus checklist, Node, Claude Code, repos, `deck.env` for the board on `/dev/ttyACM0` |
| `linux-host/create-vm-qemu.sh standin-1 --iso ...` | the Bazzite SSD | QEMU/KVM with Venus (real Vulkan in the guest), same SSH alias and registry shape |

What stays in a person's hands, by design (plan 10 § 5): the BIOS, clicking through
the Bazzite installer, `ujust toggle-ssh` in the guest, every Steam sign-in and its
Steam Guard approval, and switching this PC's Steam to offline mode before a run.

Rules every stand-in follows (plan 10 § 4, adopted 2026-10-05): offline, no games, the
automation presses only the plugin's UI and Steam's navigation to it, nothing automated
ever touches an account. Honest host names (`standin-1`, ...), never spoofed hardware.

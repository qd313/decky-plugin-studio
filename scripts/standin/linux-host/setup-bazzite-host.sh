#!/usr/bin/env bash
# Set up the maintainer's Bazzite SSD as a stand-in host (plan 10, Route B / lane L4).
# Run ON the Bazzite boot, as the desktop user. Idempotent; prints what it skipped.
#
#   bash setup-bazzite-host.sh [--repos ~/src]
#
# What it does:
#   1. virtualization: ujust setup-virtualization (libvirt, KVM, the libvirt group);
#      layers qemu-kvm/libvirt with rpm-ostree if ujust left them out (reboot needed then)
#   2. the Venus checklist: kernel >= 6.13 with udmabuf, QEMU >= 9.2, virglrenderer with
#      Venus, Mesa >= 24.2 -- reported, not fixed; these ship with current Bazzite
#   3. Node 20+ (via the system package or fnm), pnpm, Claude Code
#   4. clones of decky-plugin-studio and bonsAI, builds the MCP server
#   5. ~/.config/decky-plugin-studio/deck.env with DECK_BRIDGE_PORT=/dev/ttyACM0 so the real
#      Deck's board works from here too (pad.py takes any port string)
#   6. Ollama (ROCm 7.2+ for the RX 9070 XT, gfx1201) -- reported; the install is a curl|sh the
#      user runs by hand, because it is a root install
#
# Nothing here starts a VM. scripts/standin/linux-host/create-vm-qemu.sh does that.
set -uo pipefail
repos="$HOME/src"
while [ $# -gt 0 ]; do case "$1" in --repos) repos="$2"; shift 2;; *) echo "unknown arg $1" >&2; exit 2;; esac; done

say() { printf '\n== %s\n' "$*"; }
have() { command -v "$1" >/dev/null 2>&1; }
ver_ge() { [ "$(printf '%s\n%s' "$2" "$1" | sort -V | head -1)" = "$2" ]; }

say "host"
grep -E '^(PRETTY_NAME|VARIANT_ID|VERSION_ID)=' /etc/os-release
echo "kernel $(uname -r)"

say "virtualization"
if grep -qE 'vmx|svm' /proc/cpuinfo; then echo "CPU virtualization: present"; else echo "CPU virtualization: ABSENT -- turn VT-x on in the BIOS (plan 10 section 7)"; fi
if [ -e /dev/kvm ]; then echo "/dev/kvm: present"; else echo "/dev/kvm: missing"; fi
if have virsh && have qemu-system-x86_64; then
  echo "libvirt + qemu: present"
else
  if have ujust && ujust --list 2>/dev/null | grep -q setup-virtualization; then
    echo "running ujust setup-virtualization (may ask for sudo)"
    ujust setup-virtualization || echo "ujust setup-virtualization did not finish; see above"
  fi
  if ! have qemu-system-x86_64; then
    echo "qemu-system-x86_64 still missing; layering qemu-kvm + libvirt (reboot afterwards)"
    sudo rpm-ostree install --idempotent qemu-kvm libvirt virt-install || true
    echo "REBOOT NEEDED before QEMU is available"
  fi
fi
id -nG "$USER" | tr ' ' '\n' | grep -qx libvirt && echo "in group libvirt: yes" || echo "in group libvirt: no (sudo usermod -aG libvirt $USER, then log out/in)"

say "Venus (Vulkan in the guest) checklist"
k="$(uname -r | cut -d- -f1)"; ver_ge "$k" 6.13 && echo "kernel $k >= 6.13: ok" || echo "kernel $k < 6.13: Venus blob support missing"
if [ -e /dev/udmabuf ] || grep -q udmabuf /proc/modules 2>/dev/null || modinfo udmabuf >/dev/null 2>&1; then echo "udmabuf: available"; else echo "udmabuf: NOT available"; fi
if have qemu-system-x86_64; then q="$(qemu-system-x86_64 --version | head -1 | grep -oE '[0-9]+\.[0-9]+(\.[0-9]+)?' | head -1)"; ver_ge "$q" 9.2 && echo "QEMU $q >= 9.2: ok" || echo "QEMU $q < 9.2: Venus needs 9.2+"; fi
if ls /usr/lib64/libvirglrenderer.so* >/dev/null 2>&1; then
  if strings /usr/lib64/libvirglrenderer.so* 2>/dev/null | grep -qi venus; then echo "virglrenderer: Venus symbols present"; else echo "virglrenderer: present, Venus NOT found in symbols"; fi
else echo "virglrenderer: not found"; fi
if have vulkaninfo; then mesa="$(vulkaninfo --summary 2>/dev/null | grep -i 'driverInfo' | head -1 | grep -oE 'Mesa [0-9.]+' | head -1)"; echo "host Vulkan driver: ${mesa:-unknown}"; else echo "vulkaninfo missing (sudo rpm-ostree install vulkan-tools, or flatpak)"; fi
echo "QEMU flags for a Venus guest: -device virtio-vga-gl,hostmem=4G,blob=true,venus=true -display gtk,gl=on  (not in virt-manager yet)"

say "Node, pnpm, Claude Code"
if have node && ver_ge "$(node -v | tr -d v)" 20.0.0; then echo "node $(node -v): ok"; else
  echo "installing Node 20 with fnm (user-level)"
  if ! have fnm; then curl -fsSL https://fnm.vercel.app/install | bash -s -- --skip-shell; export PATH="$HOME/.local/share/fnm:$PATH"; fi
  eval "$(fnm env)"; fnm install 20 && fnm default 20 && echo "node $(node -v)"
fi
have pnpm || { have corepack && corepack enable && corepack prepare pnpm@latest --activate; } || npm i -g pnpm
have claude && echo "claude $(claude --version 2>/dev/null | head -1)" || { echo "installing Claude Code"; npm i -g @anthropic-ai/claude-code && echo "claude installed; run 'claude' once to sign in"; }

say "repos under $repos"
mkdir -p "$repos"
[ -d "$repos/decky-plugin-studio" ] || git clone https://github.com/cantcurecancer/decky-plugin-studio "$repos/decky-plugin-studio" || echo "clone DPS by hand into $repos/decky-plugin-studio"
[ -d "$repos/bonsAI" ] || echo "clone bonsAI into $repos/bonsAI (its remote is the maintainer's)"
if [ -d "$repos/decky-plugin-studio" ]; then (cd "$repos/decky-plugin-studio" && pnpm install --frozen-lockfile 2>/dev/null || pnpm install; pnpm run build:mcp) && echo "MCP server built"; fi

say "deck.env for the real Deck from this host"
mkdir -p "$HOME/.config/decky-plugin-studio"
envf="$HOME/.config/decky-plugin-studio/deck.env"
grep -q '^DECK_IP=' "$envf" 2>/dev/null || echo "DECK_IP=192.168.86.52" >> "$envf"
grep -q '^DECK_USER=' "$envf" 2>/dev/null || echo "DECK_USER=deck" >> "$envf"
grep -q '^DECK_BRIDGE_PORT=' "$envf" 2>/dev/null || echo "DECK_BRIDGE_PORT=/dev/ttyACM0" >> "$envf"
cat "$envf"
echo "(the board shows up as /dev/ttyACM0 or /dev/ttyUSB0; ls /dev/tty{ACM,USB}* with it plugged in)"
have python3 && python3 -c 'import serial' 2>/dev/null && echo "pyserial: ok" || echo "pyserial: pip install --user pyserial"

say "Ollama"
if have ollama; then echo "ollama $(ollama --version 2>/dev/null)"; else echo "not installed. Root install, run by hand:  curl -fsSL https://ollama.com/install.sh | sh"; fi
echo "RX 9070 XT (gfx1201) needs ROCm 7.2+; check with: rocminfo | grep gfx   and   ollama ps after a pull"
echo "models are pulled again on this side (about 45 GB for bonsAI's current set)"

say "done"
echo "If rpm-ostree layered anything above: reboot. Then: scripts/standin/linux-host/create-vm-qemu.sh standin-1"

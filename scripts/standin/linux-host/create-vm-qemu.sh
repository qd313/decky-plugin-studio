#!/usr/bin/env bash
# Start (and on first run, create) a stand-in Deck VM with QEMU/KVM and Venus on a
# Bazzite host (plan 10, Route B). Every VM gets a window on the desktop; that is the
# price of Venus today (not in virt-manager).
#
#   bash create-vm-qemu.sh standin-1 [--iso /path/bazzite-deck-stable-amd64.iso] [--dir ~/standins]
#
# First run: creates a 60 GB qcow2 and boots the ISO; install Bazzite by hand (user
# deck, host name = the VM name), run `ujust toggle-ssh` in the guest, then
# provision from DPS with scripts/standin/vm/provision.ps1's steps (a bash port is
# trivial: the ssh commands are the same).
# Later runs: boots from disk. SSH forward: 127.0.0.1:(2200+N) -> guest 22, and the
# same ~/.ssh/config alias create-vm.ps1 writes, so DPS reaches it as `deck@<name>`.
set -euo pipefail
name="${1:?usage: create-vm-qemu.sh <name> [--iso path] [--dir path]}"; shift
iso=""; dir="$HOME/standins"; cpus=4; mem=6144; disk_gb=60
while [ $# -gt 0 ]; do case "$1" in
  --iso) iso="$2"; shift 2;; --dir) dir="$2"; shift 2;; --cpus) cpus="$2"; shift 2;; --mem) mem="$2"; shift 2;;
  *) echo "unknown arg $1" >&2; exit 2;; esac; done

n="$(echo "$name" | grep -oE '[0-9]+$' || echo 1)"; port=$((2200 + n))
vmdir="$dir/$name"; disk="$vmdir/$name.qcow2"; vars="$vmdir/OVMF_VARS.fd"
mkdir -p "$vmdir"

code=""; for c in /usr/share/edk2/ovmf/OVMF_CODE.fd /usr/share/OVMF/OVMF_CODE.fd /usr/share/edk2/x64/OVMF_CODE.4m.fd; do [ -f "$c" ] && { code="$c"; break; }; done
[ -n "$code" ] || { echo "OVMF firmware not found (rpm-ostree install edk2-ovmf)" >&2; exit 1; }
[ -f "$vars" ] || cp "${code%CODE*}VARS${code##*CODE}" "$vars" 2>/dev/null || cp "$(dirname "$code")/OVMF_VARS.fd" "$vars"

first=0
if [ ! -f "$disk" ]; then
  [ -n "$iso" ] && [ -f "$iso" ] || { echo "first run needs --iso <bazzite iso>" >&2; exit 1; }
  qemu-img create -f qcow2 "$disk" "${disk_gb}G"
  first=1
fi

# ~/.ssh/config alias, same shape as create-vm.ps1
cfg="$HOME/.ssh/config"; mkdir -p "$HOME/.ssh"; touch "$cfg"
grep -qE "^Host $name\$" "$cfg" || printf '\n# decky-plugin-studio stand-in\nHost %s\n  HostName 127.0.0.1\n  Port %s\n  User deck\n  StrictHostKeyChecking accept-new\n  UserKnownHostsFile ~/.ssh/known_hosts_standins\n' "$name" "$port" >> "$cfg"

# machines.json entry (python keeps the JSON tidy; node may not be on PATH yet)
python3 - "$name" <<'PY'
import json, os, sys
name = sys.argv[1]
p = os.path.expanduser("~/.config/decky-plugin-studio/machines.json")
os.makedirs(os.path.dirname(p), exist_ok=True)
doc = {}
if os.path.exists(p):
    with open(p) as f: doc = json.load(f)
doc.setdefault("machines", {})[name] = {
    "kind": "standin", "os": "bazzite", "local": False, "host": name, "user": "deck",
    "press": "uinput", "padPort": 7690, "vm": {"hypervisor": "qemu", "name": name},
    "note": "QEMU/KVM + Venus stand-in on the Bazzite host. Steam OFFLINE; no games.",
}
with open(p, "w") as f: json.dump(doc, f, indent=2); f.write("\n")
print("registered", name, "in", p)
PY

args=(
  -name "$name" -machine q35,accel=kvm -cpu host -smp "$cpus" -m "$mem"
  -drive if=pflash,format=raw,readonly=on,file="$code" -drive if=pflash,format=raw,file="$vars"
  -drive file="$disk",if=virtio,format=qcow2
  -device virtio-vga-gl,hostmem=4G,blob=true,venus=true -display gtk,gl=on
  -device qemu-xhci -device usb-tablet
  -netdev user,id=n0,hostfwd=tcp:127.0.0.1:$port-:22 -device virtio-net-pci,netdev=n0
  -audiodev none,id=a0
  -object memory-backend-memfd,id=mem,size="${mem}M",share=on -numa node,memdev=mem
)
[ "$first" = 1 ] && args+=(-cdrom "$iso" -boot d)
echo "starting $name (ssh 127.0.0.1:$port); first run: $first"
exec qemu-system-x86_64 "${args[@]}"

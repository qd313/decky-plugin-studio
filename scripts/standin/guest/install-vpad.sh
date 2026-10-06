#!/usr/bin/env bash
# Install the DPS virtual gamepad on a stand-in Deck (run ON the stand-in, as
# the desktop user). Idempotent.
#
#   bash install-vpad.sh            # expects vpad.py beside this script
#   bash install-vpad.sh /path/to/vpad.py
#
# What it does:
#   1. copies vpad.py to ~/.local/bin/dps-vpad
#   2. installs dps-vpad.service as a user service and starts it
#   3. checks that /dev/uinput is writable by this user and that the daemon
#      answers a status query
#
# If /dev/uinput is not writable: Steam's udev rule (60-steam-input.rules)
# grants it to the logged-in seat user, which is per user, not per session --
# log this user into the desktop once and it sticks. Failing that, the rule
# below grants it to the `input` group, which this script offers to add.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
src="${1:-$here/vpad.py}"
unit_src="$here/dps-vpad.service"
[ -f "$src" ] || { echo "vpad.py not found at $src" >&2; exit 2; }
[ -f "$unit_src" ] || { echo "dps-vpad.service not found at $unit_src" >&2; exit 2; }

mkdir -p "$HOME/.local/bin" "$HOME/.config/systemd/user"
install -m 0755 "$src" "$HOME/.local/bin/dps-vpad"
install -m 0644 "$unit_src" "$HOME/.config/systemd/user/dps-vpad.service"
echo "installed ~/.local/bin/dps-vpad and the dps-vpad user service"

if [ ! -e /dev/uinput ]; then
  echo "/dev/uinput is missing; loading the uinput module (needs sudo)"
  sudo modprobe uinput || true
fi
if [ -e /dev/uinput ] && [ ! -w /dev/uinput ]; then
  echo "WARNING: /dev/uinput is not writable by $USER."
  echo "  Steam's udev rule grants it to the seat user after a desktop login as $USER."
  echo "  To grant it unconditionally instead:"
  echo "    echo 'KERNEL==\"uinput\", GROUP=\"input\", MODE=\"0660\"' | sudo tee /etc/udev/rules.d/99-dps-uinput.rules"
  echo "    sudo usermod -aG input $USER && sudo udevadm control --reload && sudo udevadm trigger"
  echo "  then log out and in."
fi

systemctl --user daemon-reload
systemctl --user enable --now dps-vpad.service
sleep 1
if systemctl --user is-active --quiet dps-vpad.service; then
  echo "dps-vpad is running:"
  python3 "$HOME/.local/bin/dps-vpad" status --port 7690 || true
else
  echo "dps-vpad did NOT start. Last log lines:" >&2
  journalctl --user -u dps-vpad.service -n 20 --no-pager >&2 || true
  exit 1
fi

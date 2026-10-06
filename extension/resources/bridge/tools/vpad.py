#!/usr/bin/env python3
"""vpad -- a virtual gamepad that stands in for the deck-bridge board.

The ESP32 board (bridge/README.md) can be plugged into exactly one machine,
and that machine is the real Deck. Every other machine Decky Plugin Studio
drives -- a Bazzite VM, or this Windows PC running Steam Big Picture -- gets
one of these instead: a software controller the OS presents to Steam as an
Xbox 360 class pad, driven over the SAME one-JSON-object-per-line protocol
the board's firmware speaks, so the host side needs no second vocabulary.

    python3 vpad.py serve [--bind 127.0.0.1] [--port 7690] [--backend auto|uinput|vigem]
    python3 vpad.py status  [--port 7690]
    python3 vpad.py press A [B ...] [--ms 80]
    python3 vpad.py hold DOWN --secs 2
    python3 vpad.py chord GUIDE A
    python3 vpad.py release

Protocol (identical to the board's, plus `chord`):

    -> {"t":"status"}                      <- {"ok":true,"t":"status","backend":"uinput","held":[]}
    -> {"t":"press","b":["A"],"ms":80}     <- {"ok":true,"t":"press","b":["A"],"ms":80}   (after the release)
    -> {"t":"hold","b":["DOWN"]}           <- {"ok":true,"t":"hold","held":["DOWN"]}
    -> {"t":"hb"}                          (no reply; refreshes the watchdog)
    -> {"t":"release"}                     <- {"ok":true,"t":"release"}
    -> {"t":"chord","hold":"GUIDE","tap":"A"}  <- {"ok":true,"t":"chord"}
    anything wrong                         <- {"ok":false,"t":"<cmd>","err":"..."}

Two safety nets, both copied from the board because they were earned there:

  WATCHDOG. A `hold` is kept only while something speaks on the link -- any
  command or a `hb` every 250 ms. 750 ms of silence and every button goes
  neutral and an {"event":"watchdog"} line is sent. A short `press` needs no
  heartbeat: its own timed release beats the watchdog.

  RELEASE ON DISCONNECT. When the client that was holding buttons goes away,
  the device goes neutral at once, whatever the watchdog would have done.

The device is created ONCE, when `serve` starts, and lives as long as the
daemon. Creating it per press would make Steam see a controller connect and
disconnect on every button, which is exactly the "controller connected"
popup storm nobody wants mid-run. Run it as a user service so it exists
before Steam starts (scripts/standin/guest/dps-vpad.service).

Backends:
  uinput -- Linux. Pure ctypes against /dev/uinput, no packages. Vendor/product
            045e:028e, the Xbox 360 wired pad, which every Steam build knows.
            Needs write access to /dev/uinput: Steam's own udev rule grants it
            to the logged-in seat user, and that ACL is per user, so the same
            user over SSH has it too.
  vigem  -- Windows. Needs the ViGEmBus driver (installed system-wide, once)
            and the `vgamepad` package (`pip install --user vgamepad`).

Button names are the board's: UP DOWN LEFT RIGHT A B X Y LB RB SELECT START
GUIDE L3 R3. Anything else is refused, never guessed at.
"""
import argparse
import json
import os
import socket
import struct
import sys
import threading
import time

BUTTONS = ["UP", "DOWN", "LEFT", "RIGHT", "A", "B", "X", "Y", "LB", "RB",
           "SELECT", "START", "GUIDE", "L3", "R3"]
WATCHDOG_MS = 750
DEFAULT_PORT = 7690
# A hold that never hears a heartbeat still ends here; so does one that does.
# Nothing automated holds a button for longer than this on purpose.
MAX_HOLD_S = 30.0


# ---------------------------------------------------------------------------
# Backends
# ---------------------------------------------------------------------------

class Backend:
    name = "none"

    def set_held(self, held):
        """Make exactly `held` (a set of button names) the pressed set."""
        raise NotImplementedError

    def close(self):
        pass


class UinputBackend(Backend):
    """Xbox 360 class pad through /dev/uinput, with nothing but ctypes/struct."""
    name = "uinput"

    # <linux/input-event-codes.h>
    EV_SYN, EV_KEY, EV_ABS = 0x00, 0x01, 0x03
    SYN_REPORT = 0
    ABS_X, ABS_Y, ABS_Z, ABS_RX, ABS_RY, ABS_RZ = 0x00, 0x01, 0x02, 0x03, 0x04, 0x05
    ABS_HAT0X, ABS_HAT0Y = 0x10, 0x11
    KEYS = {
        "A": 0x130, "B": 0x131, "X": 0x133, "Y": 0x134,
        "LB": 0x136, "RB": 0x137, "SELECT": 0x13A, "START": 0x13B,
        "GUIDE": 0x13C, "L3": 0x13D, "R3": 0x13E,
    }
    HAT = {"LEFT": (ABS_HAT0X, -1), "RIGHT": (ABS_HAT0X, 1),
           "UP": (ABS_HAT0Y, -1), "DOWN": (ABS_HAT0Y, 1)}

    # <linux/uinput.h> ioctl numbers for x86_64 (see the derivation in plan 10's session notes:
    # _IOW('U', n, size) = 0x40000000 | size << 16 | 0x55 << 8 | n).
    UI_SET_EVBIT = 0x40045564
    UI_SET_KEYBIT = 0x40045565
    UI_SET_ABSBIT = 0x40045567
    UI_DEV_SETUP = 0x405C5503     # struct uinput_setup, 92 bytes
    UI_ABS_SETUP = 0x401C5504     # struct uinput_abs_setup, 28 bytes
    UI_DEV_CREATE = 0x5501
    UI_DEV_DESTROY = 0x5502
    BUS_USB = 0x03

    def __init__(self, device="/dev/uinput", name="Microsoft X-Box 360 pad"):
        import fcntl
        self._fcntl = fcntl
        try:
            self.fd = os.open(device, os.O_WRONLY | os.O_NONBLOCK)
        except PermissionError as e:
            raise SystemExit(
                f"cannot open {device}: {e}. Steam's udev rule grants the seat user access; "
                "log the same user into the desktop once, or add a udev rule / `input` group membership."
            )
        except FileNotFoundError:
            raise SystemExit(f"{device} does not exist -- is the uinput module loaded? (sudo modprobe uinput)")
        ioctl = self._fcntl.ioctl
        ioctl(self.fd, self.UI_SET_EVBIT, self.EV_KEY)
        ioctl(self.fd, self.UI_SET_EVBIT, self.EV_ABS)
        for code in self.KEYS.values():
            ioctl(self.fd, self.UI_SET_KEYBIT, code)
        # struct uinput_abs_setup { __u16 code; (pad) struct input_absinfo { __s32 value, minimum,
        # maximum, fuzz, flat, resolution } }  -> "H2x6i" = 28 bytes
        axes = [
            (self.ABS_X, -32768, 32767, 16, 128), (self.ABS_Y, -32768, 32767, 16, 128),
            (self.ABS_RX, -32768, 32767, 16, 128), (self.ABS_RY, -32768, 32767, 16, 128),
            (self.ABS_Z, 0, 255, 0, 0), (self.ABS_RZ, 0, 255, 0, 0),
            (self.ABS_HAT0X, -1, 1, 0, 0), (self.ABS_HAT0Y, -1, 1, 0, 0),
        ]
        for code, lo, hi, fuzz, flat in axes:
            ioctl(self.fd, self.UI_SET_ABSBIT, code)
            ioctl(self.fd, self.UI_ABS_SETUP, struct.pack("H2x6i", code, 0, lo, hi, fuzz, flat, 0))
        # struct uinput_setup { struct input_id {__u16 bustype, vendor, product, version}; char name[80]; __u32 ff_effects_max }
        setup = struct.pack("HHHH80sI", self.BUS_USB, 0x045E, 0x028E, 0x0114, name.encode()[:79], 0)
        ioctl(self.fd, self.UI_DEV_SETUP, setup)
        ioctl(self.fd, self.UI_DEV_CREATE)
        self._held = set()
        # Let udev and Steam notice the new device before anything is pressed.
        time.sleep(0.5)
        self.set_held(set())

    def _emit(self, etype, code, value):
        now = time.time()
        sec, usec = int(now), int((now - int(now)) * 1_000_000)
        # struct input_event on 64-bit: struct timeval {long, long}; __u16 type; __u16 code; __s32 value
        os.write(self.fd, struct.pack("@llHHi", sec, usec, etype, code, value))

    def set_held(self, held):
        held = set(held)
        for name, code in self.KEYS.items():
            self._emit(self.EV_KEY, code, 1 if name in held else 0)
        hx = (1 if "RIGHT" in held else 0) - (1 if "LEFT" in held else 0)
        hy = (1 if "DOWN" in held else 0) - (1 if "UP" in held else 0)
        self._emit(self.EV_ABS, self.ABS_HAT0X, hx)
        self._emit(self.EV_ABS, self.ABS_HAT0Y, hy)
        self._emit(self.EV_SYN, self.SYN_REPORT, 0)
        self._held = held

    def close(self):
        try:
            self.set_held(set())
            self._fcntl.ioctl(self.fd, self.UI_DEV_DESTROY)
            os.close(self.fd)
        except Exception:
            pass


class VigemBackend(Backend):
    """Xbox 360 pad through the ViGEmBus driver, via the vgamepad package."""
    name = "vigem"

    def __init__(self):
        try:
            import vgamepad as vg
        except ImportError:
            raise SystemExit("the vgamepad package is missing: python -m pip install --user vgamepad")
        try:
            self.pad = vg.VX360Gamepad()
        except Exception as e:  # the driver is the usual culprit
            raise SystemExit(f"could not create a ViGEm pad: {e}. Is the ViGEmBus driver installed (winget install ViGEm.ViGEmBus)?")
        B = vg.XUSB_BUTTON
        self.MAP = {
            "UP": B.XUSB_GAMEPAD_DPAD_UP, "DOWN": B.XUSB_GAMEPAD_DPAD_DOWN,
            "LEFT": B.XUSB_GAMEPAD_DPAD_LEFT, "RIGHT": B.XUSB_GAMEPAD_DPAD_RIGHT,
            "A": B.XUSB_GAMEPAD_A, "B": B.XUSB_GAMEPAD_B, "X": B.XUSB_GAMEPAD_X, "Y": B.XUSB_GAMEPAD_Y,
            "LB": B.XUSB_GAMEPAD_LEFT_SHOULDER, "RB": B.XUSB_GAMEPAD_RIGHT_SHOULDER,
            "SELECT": B.XUSB_GAMEPAD_BACK, "START": B.XUSB_GAMEPAD_START, "GUIDE": B.XUSB_GAMEPAD_GUIDE,
            "L3": B.XUSB_GAMEPAD_LEFT_THUMB, "R3": B.XUSB_GAMEPAD_RIGHT_THUMB,
        }
        time.sleep(0.5)
        self.set_held(set())

    def set_held(self, held):
        held = set(held)
        for name, flag in self.MAP.items():
            if name in held:
                self.pad.press_button(button=flag)
            else:
                self.pad.release_button(button=flag)
        self.pad.update()

    def close(self):
        try:
            self.set_held(set())
            self.pad.reset()
            self.pad.update()
        except Exception:
            pass


def make_backend(which):
    if which == "auto":
        which = "vigem" if sys.platform == "win32" else "uinput"
    if which == "uinput":
        return UinputBackend()
    if which == "vigem":
        return VigemBackend()
    raise SystemExit(f"unknown backend {which}")


# ---------------------------------------------------------------------------
# The pad: one held-set, one lock, one watchdog
# ---------------------------------------------------------------------------

class Pad:
    def __init__(self, backend):
        self.backend = backend
        self.lock = threading.RLock()
        self.held = set()
        self.last_voice = time.monotonic()
        self.hold_started = None
        self.watchdog_tripped = False
        self.started = time.monotonic()
        self._stop = threading.Event()
        threading.Thread(target=self._watchdog, daemon=True).start()

    def heard(self):
        self.last_voice = time.monotonic()

    def _apply(self, held):
        with self.lock:
            self.held = set(held)
            self.backend.set_held(self.held)
            self.hold_started = time.monotonic() if self.held else None

    def release(self):
        self._apply(set())

    def hold(self, names):
        self.watchdog_tripped = False
        self._apply(names)

    def press(self, names, ms):
        with self.lock:
            self._apply(names)
            time.sleep(max(1, ms) / 1000.0)
            self._apply(set())

    def chord(self, hold_btn, tap_btn):
        # The same four overlapping states chord.py sends on the wire, with its timings.
        with self.lock:
            self._apply({hold_btn});            time.sleep(0.25)
            self._apply({hold_btn, tap_btn});   time.sleep(0.12)
            self._apply({hold_btn});            time.sleep(0.15)
            self._apply(set())

    def _watchdog(self):
        while not self._stop.is_set():
            time.sleep(0.05)
            if not self.held:
                continue
            silent_ms = (time.monotonic() - self.last_voice) * 1000
            too_long = self.hold_started is not None and time.monotonic() - self.hold_started > MAX_HOLD_S
            if silent_ms > WATCHDOG_MS or too_long:
                self._apply(set())
                self.watchdog_tripped = True
                Server.broadcast({"event": "watchdog",
                                  "detail": "hold cap reached, neutralized" if too_long else "link silent, neutralized"})

    def status(self):
        return {"backend": self.backend.name, "held": sorted(self.held),
                "watchdog_ms": WATCHDOG_MS, "watchdog_tripped": self.watchdog_tripped,
                "uptime_s": round(time.monotonic() - self.started, 1), "pid": os.getpid()}

    def close(self):
        self._stop.set()
        self.backend.close()


# ---------------------------------------------------------------------------
# The server
# ---------------------------------------------------------------------------

class Server:
    clients = set()
    clients_lock = threading.Lock()

    @classmethod
    def broadcast(cls, obj):
        line = (json.dumps(obj, separators=(",", ":")) + "\n").encode()
        with cls.clients_lock:
            for c in list(cls.clients):
                try:
                    c.sendall(line)
                except Exception:
                    pass

    def __init__(self, pad, bind, port):
        self.pad = pad
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.sock.bind((bind, port))
        self.sock.listen(8)
        self.bind, self.port = bind, port

    def serve_forever(self):
        print(f"vpad: {self.pad.backend.name} pad up, listening on {self.bind}:{self.port}", flush=True)
        while True:
            conn, addr = self.sock.accept()
            threading.Thread(target=self._client, args=(conn,), daemon=True).start()

    def _client(self, conn):
        with Server.clients_lock:
            Server.clients.add(conn)
        conn.settimeout(None)
        buf = b""
        holding_here = False
        try:
            while True:
                chunk = conn.recv(4096)
                if not chunk:
                    break
                buf += chunk
                while b"\n" in buf:
                    line, buf = buf.split(b"\n", 1)
                    line = line.strip()
                    if not line:
                        continue
                    reply, holding_here = self._handle(line, holding_here)
                    if reply is not None:
                        conn.sendall((json.dumps(reply, separators=(",", ":")) + "\n").encode())
        except (ConnectionError, OSError):
            pass
        finally:
            with Server.clients_lock:
                Server.clients.discard(conn)
            if holding_here and self.pad.held:
                # The client that was holding buttons is gone. Neutral, now.
                self.pad.release()
            try:
                conn.close()
            except Exception:
                pass

    def _handle(self, line, holding_here):
        try:
            cmd = json.loads(line.decode("utf-8", "replace"))
        except ValueError:
            return {"ok": False, "t": "?", "err": "not JSON"}, holding_here
        t = cmd.get("t")
        self.pad.heard()
        if t == "hb":
            return None, holding_here
        if t == "status":
            return {"ok": True, "t": "status", **self.pad.status()}, holding_here
        if t == "release":
            self.pad.release()
            return {"ok": True, "t": "release"}, False
        if t in ("press", "hold"):
            names = [str(b).strip().upper() for b in (cmd.get("b") or [])]
            bad = [b for b in names if b not in BUTTONS]
            if not names:
                return {"ok": False, "t": t, "err": "name at least one button"}, holding_here
            if bad:
                return {"ok": False, "t": t, "err": f"unknown button(s): {', '.join(bad)}; known: {' '.join(BUTTONS)}"}, holding_here
            if t == "press":
                ms = int(cmd.get("ms", 80))
                if ms < 1 or ms > 5000:
                    return {"ok": False, "t": t, "err": "ms must be 1..5000"}, holding_here
                self.pad.press(set(names), ms)
                return {"ok": True, "t": "press", "b": names, "ms": ms}, holding_here
            self.pad.hold(set(names))
            return {"ok": True, "t": "hold", "held": sorted(names)}, True
        if t == "chord":
            h = str(cmd.get("hold", "")).strip().upper()
            tp = str(cmd.get("tap", "")).strip().upper()
            bad = [b for b in (h, tp) if b not in BUTTONS]
            if bad:
                return {"ok": False, "t": "chord", "err": f"unknown button(s): {', '.join(bad)}"}, holding_here
            self.pad.chord(h, tp)
            return {"ok": True, "t": "chord", "hold": h, "tap": tp}, holding_here
        return {"ok": False, "t": str(t), "err": "unknown command"}, holding_here


# ---------------------------------------------------------------------------
# A small client, so a human can poke the daemon the way pad.py pokes the board
# ---------------------------------------------------------------------------

def client(host, port, obj, wait_s=3.0, hb=False, secs=0.0):
    s = socket.create_connection((host, port), timeout=wait_s)
    s.settimeout(0.1)
    raw = json.dumps(obj, separators=(",", ":")) + "\n"
    s.sendall(raw.encode())
    print(f"-> {raw.strip()}")
    deadline = time.time() + max(wait_s, secs + 0.5)
    buf = b""
    next_hb = time.time()
    while time.time() < deadline:
        if hb and time.time() >= next_hb:
            s.sendall(b'{"t":"hb"}\n')
            next_hb = time.time() + 0.25
        try:
            chunk = s.recv(4096)
        except socket.timeout:
            chunk = b""
        if chunk:
            buf += chunk
            while b"\n" in buf:
                line, buf = buf.split(b"\n", 1)
                print("<- " + line.decode("utf-8", "replace"))
                if not hb:
                    s.close()
                    return
    if hb:
        s.sendall(b'{"t":"release"}\n')
        time.sleep(0.2)
    s.close()


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("cmd", choices=["serve", "status", "press", "hold", "chord", "release"])
    ap.add_argument("buttons", nargs="*")
    ap.add_argument("--bind", default="127.0.0.1")
    ap.add_argument("--host", default="127.0.0.1", help="client: where the daemon is")
    ap.add_argument("--port", type=int, default=DEFAULT_PORT)
    ap.add_argument("--backend", default="auto", choices=["auto", "uinput", "vigem"])
    ap.add_argument("--ms", type=int, default=80)
    ap.add_argument("--secs", type=float, default=2.0)
    args = ap.parse_args()

    if args.cmd == "serve":
        pad = Pad(make_backend(args.backend))
        try:
            Server(pad, args.bind, args.port).serve_forever()
        except KeyboardInterrupt:
            pass
        finally:
            pad.close()
        return

    if args.cmd == "status":
        client(args.host, args.port, {"t": "status"})
    elif args.cmd == "release":
        client(args.host, args.port, {"t": "release"})
    elif args.cmd == "press":
        if not args.buttons:
            sys.exit("name at least one button")
        client(args.host, args.port, {"t": "press", "b": args.buttons, "ms": args.ms}, wait_s=args.ms / 1000 + 3)
    elif args.cmd == "hold":
        if not args.buttons:
            sys.exit("name at least one button")
        client(args.host, args.port, {"t": "hold", "b": args.buttons}, hb=True, secs=args.secs)
    elif args.cmd == "chord":
        if len(args.buttons) != 2:
            sys.exit("chord takes exactly two buttons: HOLD TAP")
        client(args.host, args.port, {"t": "chord", "hold": args.buttons[0], "tap": args.buttons[1]}, wait_s=5)


if __name__ == "__main__":
    main()

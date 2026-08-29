#!/usr/bin/env python
"""Drive the deck-bridge board over the COM port.

  python pad.py status
  python pad.py press DOWN                 # one 80 ms press
  python pad.py press DOWN --ms 200
  python pad.py press A B                  # chord
  python pad.py hold DOWN --secs 3         # heartbeat keeps it alive
  python pad.py release
  python pad.py watchdog-test              # prove the safety net fires

A short press needs no heartbeat: the board's own timed release (80 ms) beats
the 750 ms watchdog. A hold does need one, which is the design working.
"""
import argparse
import json
import sys
import threading
import time

import serial

BAUD = 115200

# Windows serial writes are not safe from two threads at once - the heartbeat
# and the command thread will collide and raise a write timeout. One lock owns
# every write to the port.
_write_lock = threading.Lock()


def _write(p, data):
    with _write_lock:
        p.write(data)
        p.flush()


def open_port(port, settle=2.5, probe_s=0.3):
    p = serial.Serial()
    p.port = port
    p.baudrate = BAUD
    p.dtr = False          # do not drive the auto-reset lines
    p.rts = False
    p.timeout = 0.05       # read timeout
    p.write_timeout = 2.0  # explicit, so a stall is an error not a hang
    p.open()

    # Ask the board whether it is up, rather than waiting to be told.
    #
    # The two lines above hold DTR and RTS low precisely so that opening the port does NOT reset
    # the board. A board that was not reset never prints the "ready" line, so the wait below could
    # only ever run to its full timeout -- and it did, on every single invocation. Measured
    # 2026-08-28 against a live board: open_port took 2.523s and never saw "ready", while a status
    # ping came back in 0.009s. That was ~2.5s of dead time on every press the QA rig sent.
    #
    # So probe first and treat an answer as proof of life. status only reports; it moves nothing.
    try:
        p.reset_input_buffer()
        p.write(b'{"t":"status"}\n')
        p.flush()
        deadline = time.time() + probe_s
        while time.time() < deadline:
            if b'"t"' in p.readline():
                return p
    except Exception:
        pass  # fall through to the original wait, which is the safe answer to any probe failure

    # No answer. The board may genuinely be booting -- a fresh flash, or a driver that reset it on
    # open despite the lines above -- so wait for it the way this always did.
    deadline = time.time() + settle
    while time.time() < deadline:
        if b'"ready"' in p.readline():
            return p
    return p


def send(p, obj, echo=True):
    raw = json.dumps(obj, separators=(",", ":")) + "\n"
    _write(p, raw.encode())
    if echo:
        print(f"-> {raw.strip()}")


def drain(p, secs, prefix="<- ", until=None, min_secs=0.0):
    """Print everything the board says, for `secs` or until it has answered.

    `until` is a marker to look for in a line -- once it is seen the drain can stop, because the
    board has said what the caller was waiting for. The board answers in milliseconds, so the
    fixed windows this used to run were almost entirely spent reading nothing.

    `min_secs` is the floor, and it is load-bearing for `press`: the caller's `finally` writes a
    release, so returning before the requested hold has elapsed would cut the press short. The ack
    can arrive well before the hold finishes.
    """
    start = time.time()
    deadline = start + secs
    answered = False
    while time.time() < deadline:
        line = p.readline()
        if line:
            text = line.decode("utf-8", "replace")
            print(prefix + text.rstrip())
            if until and until in text:
                answered = True
        if answered and time.time() - start >= min_secs:
            return


class Heartbeat(threading.Thread):
    """4 Hz heartbeat, as specified in plan 19 section 3."""

    def __init__(self, port):
        super().__init__(daemon=True)
        self.p = port
        self.stop_flag = threading.Event()

    def run(self):
        while not self.stop_flag.is_set():
            try:
                _write(self.p, b'{"t":"hb"}\n')
            except Exception:
                return
            time.sleep(0.25)

    def stop(self):
        self.stop_flag.set()
        self.join(timeout=1.0)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", choices=["status", "press", "hold", "release",
                                    "watchdog-test"])
    ap.add_argument("buttons", nargs="*", help="UP DOWN LEFT RIGHT A B X Y "
                                              "LB RB SELECT START GUIDE")
    ap.add_argument("--port", default="COM7")
    ap.add_argument("--ms", type=int, default=80)
    ap.add_argument("--secs", type=float, default=2.0)
    args = ap.parse_args()

    p = open_port(args.port)
    hb = None
    try:
        if args.cmd == "status":
            send(p, {"t": "status"})
            drain(p, 0.5, until='"t":"status"')

        elif args.cmd == "release":
            send(p, {"t": "release"})
            drain(p, 0.5, until='"t":"release"')

        elif args.cmd == "press":
            if not args.buttons:
                sys.exit("name at least one button")
            send(p, {"t": "press", "b": args.buttons, "ms": args.ms})
            # The old window was the full max(1.0, ms/1000 + 0.7) whatever the board did. Stop at
            # the ack instead, but not before the hold has had time to finish -- see `drain`.
            drain(
                p,
                max(1.0, args.ms / 1000 + 0.7),
                until='"t":"press"',
                min_secs=args.ms / 1000 + 0.05,
            )

        elif args.cmd == "hold":
            if not args.buttons:
                sys.exit("name at least one button")
            hb = Heartbeat(p)
            hb.start()
            send(p, {"t": "hold", "b": args.buttons})
            drain(p, args.secs)
            hb.stop()
            hb = None
            send(p, {"t": "release"})
            drain(p, 0.5)

        elif args.cmd == "watchdog-test":
            print("holding DOWN with a live heartbeat for 2s ...")
            hb = Heartbeat(p)
            hb.start()
            send(p, {"t": "hold", "b": ["DOWN"]})
            drain(p, 2.0)
            print("\n*** cutting the heartbeat - simulating a dead PC ***\n")
            hb.stop()
            hb = None
            drain(p, 2.5)
            send(p, {"t": "status"})
            drain(p, 0.5)
    finally:
        if hb is not None:
            hb.stop()
        # Never leave the board holding anything.
        try:
            _write(p, b'{"t":"release"}\n')
            time.sleep(0.1)
        except Exception:
            pass
        p.close()


if __name__ == "__main__":
    main()

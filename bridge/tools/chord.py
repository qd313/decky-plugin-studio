#!/usr/bin/env python
"""Hold one button, tap another, release - a real chord on the wire.

  python chord.py GUIDE A

Sends overlapping HID reports (hold -> hold+tap -> hold -> neutral) rather than
one report with both bits set, because that is what a human chord looks like and
what plan 19's deck_padChord specifies. Runs a heartbeat so the watchdog does
not neutralise mid-chord.
"""
import json, sys, threading, time
import serial

# `--port COMx` anywhere on the line picks the serial port; the positional
# arguments are the two buttons. Until 2026-10-05 the port was hard-wired to
# COM7 and a `--port` from pressButton.ts was silently ignored.
_argv = sys.argv[1:]
port_name = "COM7"
if "--port" in _argv:
    i = _argv.index("--port")
    if i + 1 < len(_argv):
        port_name = _argv[i + 1]
    del _argv[i:i + 2]
hold_btn = _argv[0] if len(_argv) > 0 else "GUIDE"
tap_btn = _argv[1] if len(_argv) > 1 else "A"

p = serial.Serial()
p.port, p.baudrate = port_name, 115200
p.dtr = p.rts = False
p.timeout = 0.02
p.write_timeout = 2.0
p.open()
time.sleep(0.2)
p.reset_input_buffer()

lock = threading.Lock()
stop = threading.Event()

def w(obj):
    with lock:
        p.write(json.dumps(obj, separators=(",", ":")).encode() + b"\n")
        p.flush()

def beat():
    while not stop.is_set():
        w({"t": "hb"})
        time.sleep(0.2)

def show(secs):
    end = time.time() + secs
    while time.time() < end:
        line = p.readline()
        if line:
            print("   " + line.decode("utf-8", "replace").rstrip(), flush=True)

hb = threading.Thread(target=beat, daemon=True)
hb.start()
try:
    print(f"1. hold {hold_btn}", flush=True);            w({"t": "hold", "b": [hold_btn]});           show(0.25)
    print(f"2. tap {tap_btn} while held", flush=True);   w({"t": "hold", "b": [hold_btn, tap_btn]});  show(0.12)
    print(f"3. release {tap_btn}, keep {hold_btn}", flush=True); w({"t": "hold", "b": [hold_btn]});  show(0.15)
    print("4. release all", flush=True);                 w({"t": "release"});                         show(0.5)
finally:
    stop.set()
    time.sleep(0.05)
    w({"t": "release"})
    time.sleep(0.1)
    p.close()
print("chord sent")

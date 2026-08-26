#!/usr/bin/env python
"""Press named buttons one at a time so a human can watch which one lights up
in Steam's Test Device Inputs view. Opens the port once, unlike pad.py."""
import sys, time
import serial, json

names = sys.argv[1:] or ["A", "B", "X", "Y"]
p = serial.Serial()
p.port, p.baudrate = "COM7", 115200
p.dtr = p.rts = False
p.timeout = 0.05
p.write_timeout = 2.0
p.open()
time.sleep(0.2)
p.reset_input_buffer()

for n in names:
    print(f"--- pressing {n} (600 ms) ---", flush=True)
    p.write(json.dumps({"t": "press", "b": [n], "ms": 600}).encode() + b"\n")
    p.flush()
    end = time.time() + 2.5
    while time.time() < end:
        line = p.readline()
        if line:
            print("   " + line.decode("utf-8", "replace").rstrip(), flush=True)

p.write(b'{"t":"release"}\n')
p.flush()
time.sleep(0.2)
p.close()
print("done")

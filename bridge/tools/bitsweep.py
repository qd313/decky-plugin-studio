#!/usr/bin/env python
"""Press raw button bits 0..15 one at a time, on a fixed schedule, so a video
of Steam's input tester can be aligned and diffed mechanically.

Starts with a 1.5 s press of bit 0 as a clapperboard. Bit 0 is known to light
Steam's A button, so it is easy to find in the video and everything after it is
at a known offset. Writes schedule.json for the frame extractor.
"""
import json, time
import serial

PORT = "COM7"
CLAPPER_MS = 1500
CLAPPER_GAP = 1.5
PRESS_MS = 600
GAP = 1.4          # so each bit occupies exactly 2.0 s
NBITS = 16

p = serial.Serial()
p.port, p.baudrate = PORT, 115200
p.dtr = p.rts = False
p.timeout = 0.02
p.write_timeout = 2.0
p.open()
time.sleep(0.2)
p.reset_input_buffer()


def cmd(obj):
    p.write(json.dumps(obj, separators=(",", ":")).encode() + b"\n")
    p.flush()


print("=== CLAPPER: bit 0 (A) for 1.5s ===", flush=True)
t0 = time.time()
cmd({"t": "press", "mask": 1, "ms": CLAPPER_MS})
time.sleep(CLAPPER_MS / 1000 + CLAPPER_GAP)

schedule = []
for n in range(NBITS):
    offset = time.time() - t0
    print(f"--- bit {n:2d}  (mask {1 << n:5d})  t+{offset:6.2f}s ---", flush=True)
    cmd({"t": "press", "mask": 1 << n, "ms": PRESS_MS})
    schedule.append({"bit": n, "mask": 1 << n, "t_after_clapper": round(offset, 3)})
    time.sleep(PRESS_MS / 1000 + GAP)

cmd({"t": "release"})
time.sleep(0.2)
p.close()

meta = {
    "clapper_ms": CLAPPER_MS,
    "press_ms": PRESS_MS,
    "note": "t_after_clapper is seconds from the START of the clapper press",
    "presses": schedule,
}
with open("schedule.json", "w") as f:
    json.dump(meta, f, indent=2)
print("\ndone - schedule.json written", flush=True)

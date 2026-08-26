import subprocess, pathlib, sys
import numpy as np
from PIL import Image

VID = sys.argv[1]
OUT = pathlib.Path("frames")
FPS = 10.0

if not OUT.exists():
    OUT.mkdir()
    subprocess.run(["ffmpeg", "-v", "error", "-i", VID,
                    "-vf", f"fps={FPS},scale=640:-2", "-q:v", "3",
                    str(OUT / "f_%05d.jpg")], check=True)

fs = sorted(OUT.glob("f_*.jpg"))
print(f"{len(fs)} frames")

def load(p):
    return np.asarray(Image.open(p).convert("L"), dtype=np.int16)

# Try several baselines; the recorder may overlay something at the start.
for base_t in (0.5, 3.0, 60.0):
    base = load(fs[int(base_t * FPS)])
    act = np.array([np.abs(load(f) - base).__gt__(28).sum() for f in fs])
    print(f"\n=== baseline at t={base_t}s ===")
    print(f"min={act.min()} p25={int(np.percentile(act,25))} "
          f"median={int(np.median(act))} p90={int(np.percentile(act,90))} max={act.max()}")
    # print half-second buckets that are clearly above the floor
    floor = np.percentile(act, 40)
    hot = [(i / FPS, int(v)) for i, v in enumerate(act) if v > max(floor * 3, 60)]
    print(f"{len(hot)} 'hot' frames")
    if hot:
        # collapse into runs
        runs, start, prev = [], hot[0][0], hot[0][0]
        for t, v in hot[1:]:
            if t - prev > 0.35:
                runs.append((start, prev))
                start = t
            prev = t
        runs.append((start, prev))
        print("runs (start..end seconds):")
        for a, b in runs[:40]:
            print(f"   {a:7.2f} .. {b:7.2f}   ({b-a:.2f}s)")

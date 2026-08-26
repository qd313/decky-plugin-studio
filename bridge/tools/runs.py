import pathlib
import numpy as np
from PIL import Image

FPS = 10.0
fs = sorted(pathlib.Path("frames").glob("f_*.jpg"))
load = lambda p: np.asarray(Image.open(p).convert("L"), dtype=np.int16)
base = load(fs[int(60 * FPS)])          # clean resting frame
H, W = base.shape

def mask(f):
    m = np.abs(load(f) - base) > 28
    m[:20, :] = False    # status bar: clock + battery tick on their own
    return m

act = np.array([mask(f).sum() for f in fs[:int(50 * FPS)]])
live = act > 60

runs, start = [], None
for i, v in enumerate(live):
    if v and start is None:
        start = i
    elif not v and start is not None:
        runs.append((start, i - 1)); start = None
if start is not None:
    runs.append((start, len(live) - 1))

print(f"{'t_start':>8} {'dur':>5}  {'px':>6}  bbox x0,y0,x1,y1 (of {W}x{H})   centre frac")
print("-" * 82)
for a, b in runs:
    mid = (a + b) // 2
    m = mask(fs[mid])
    ys, xs = np.nonzero(m)
    if len(xs) < 20:
        continue
    x0, y0, x1, y1 = xs.min(), ys.min(), xs.max(), ys.max()
    cx, cy = (x0 + x1) / 2 / W, (y0 + y1) / 2 / H
    print(f"{a/FPS:8.2f} {(b-a+1)/FPS:5.2f}  {len(xs):6d}  "
          f"({x0:3d},{y0:3d},{x1:3d},{y1:3d})   ({cx:.3f}, {cy:.3f})")

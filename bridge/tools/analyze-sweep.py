#!/usr/bin/env python
"""Work out which Steam button each raw bit lights, from a video of the input
tester recorded during bitsweep.py.

Mechanical only: frames are differenced against a resting baseline and the
bounding box of the changed pixels is reported. Nothing here judges what a
button "looks like" - a box either overlaps a region or it does not.

  python analyze-sweep.py <video> [--fps 10]
"""
import argparse, json, subprocess, sys, tempfile, pathlib
import numpy as np
from PIL import Image

CLAPPER_LEN = 1.5      # seconds the clapper press is held
FIRST_BIT_AT = 3.0     # bit 0 starts this long after the clapper starts
BIT_PERIOD = 2.0
MID_PRESS = 0.30       # sample this far into each 600 ms press


def frames(video, fps, outdir):
    subprocess.run(
        ["ffmpeg", "-v", "error", "-i", video,
         "-vf", f"fps={fps},scale=640:-2", "-q:v", "3",
         str(pathlib.Path(outdir) / "f_%05d.jpg")],
        check=True)
    return sorted(pathlib.Path(outdir).glob("f_*.jpg"))


def load(path):
    return np.asarray(Image.open(path).convert("L"), dtype=np.int16)


def diff_mask(frame, base, thresh=28):
    return (np.abs(frame - base) > thresh)


def bbox(mask, min_px=40):
    ys, xs = np.nonzero(mask)
    if len(xs) < min_px:
        return None
    return int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max()), int(len(xs))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("video")
    ap.add_argument("--fps", type=float, default=10.0)
    ap.add_argument("--baseline-sec", type=float, default=0.5,
                    help="how far into the video to take the resting frame")
    args = ap.parse_args()

    tmp = tempfile.mkdtemp(prefix="sweep_")
    fs = frames(args.video, args.fps, tmp)
    if not fs:
        sys.exit("ffmpeg produced no frames")
    print(f"{len(fs)} frames at {args.fps} fps from {args.video}")

    base = load(fs[int(args.baseline_sec * args.fps)])
    h, w = base.shape
    print(f"frame size {w}x{h}\n")

    # Activity per frame, to find the clapper: the first long burst of change.
    activity = np.array([diff_mask(load(f), base).sum() for f in fs])
    floor = np.percentile(activity, 40)
    live = activity > max(floor * 3, 60)

    run_start, best = None, None
    need = int(CLAPPER_LEN * args.fps * 0.6)
    for i, v in enumerate(live):
        if v and run_start is None:
            run_start = i
        elif not v and run_start is not None:
            if i - run_start >= need:
                best = run_start
                break
            run_start = None
    if best is None:
        sys.exit("could not find the clapper - check the recording covers it")

    t_clap = best / args.fps
    print(f"clapper found at t={t_clap:.2f}s in the video\n")

    print(f"{'bit':>3}  {'mask':>6}  {'px':>6}  bbox (x0,y0,x1,y1)   "
          f"centre as fraction of frame")
    print("-" * 78)
    results = []
    for n in range(16):
        t = t_clap + FIRST_BIT_AT + BIT_PERIOD * n + MID_PRESS
        idx = int(round(t * args.fps))
        if idx >= len(fs):
            print(f"{n:>3}  {'':>6}  video ended before this press")
            continue
        b = bbox(diff_mask(load(fs[idx]), base))
        if b is None:
            print(f"{n:>3}  {1<<n:>6}  {'-':>6}  (nothing lit)")
            results.append({"bit": n, "lit": False})
            continue
        x0, y0, x1, y1, px = b
        cx, cy = (x0 + x1) / 2 / w, (y0 + y1) / 2 / h
        print(f"{n:>3}  {1<<n:>6}  {px:>6}  ({x0:4d},{y0:4d},{x1:4d},{y1:4d})   "
              f"({cx:.3f}, {cy:.3f})")
        results.append({"bit": n, "lit": True, "bbox": [x0, y0, x1, y1],
                        "px": px, "centre": [round(cx, 4), round(cy, 4)]})

    with open("sweep-results.json", "w") as f:
        json.dump({"video": args.video, "clapper_t": t_clap,
                   "frame": [w, h], "results": results}, f, indent=2)
    print("\nwrote sweep-results.json")


if __name__ == "__main__":
    main()

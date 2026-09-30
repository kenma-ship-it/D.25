"""
Builds the SMOOTH frame set for the cinematic film from DE.25's own five
source videos (Video1.mp4 … Video 5.mp4, one folder above this project).

The supplied frames in public/frames/seq1 + seq2 are every ~5th video frame
(185 in total), which makes scrolling step from picture to picture. This
script takes every 2nd video frame over exactly the same scene ranges
(≈430 frames) and writes them as still WebP images. The website still plays
NO video — it remains an image sequence, just denser. The supplied frames
are left untouched.

Output
  public/frames/smooth/d/NNNN.webp   1280×720  (desktop)
  public/frames/smooth/m/NNNN.webp    960×540  (phones)
  public/frames/manifest-smooth.json

Run:  python scripts/build-smooth-frames.py   (needs opencv-python + Pillow)

Scene ranges were found by matching the supplied frames against the videos
(first/last matching video frame per sequence), so the new set shows the same
five scenes in the same order and proportions — category timing in
js/cinematicMenu.js (TIMELINE, as fractions of the film) still lines up.
"""
import json
import os
import sys

import cv2
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
PROJECT = os.path.dirname(HERE)
VIDEOS = os.path.dirname(PROJECT)
OUT = os.path.join(PROJECT, "public", "frames", "smooth")
STEP = 2  # every 2nd video frame (24 fps source → 12 frames per second of footage)

# (sequence, label, video file, first frame, last frame) — inclusive, 0-based
SEQUENCES = [
    (1, "The shop", "Video1.mp4", 0, 167),
    (2, "Blueberry cheesecake", "Video 2.mp4", 59, 187),
    (3, "Boxed to take home", "Video 3.mp4", 0, 187),
    (4, "Korean bun", "Video 4.mp4", 1, 187),
    (5, "Chocolate shake", "Video 5.mp4", 0, 184),
]
VARIANTS = {
    # key: (width, height, webp quality)
    "d": (1280, 720, 64),
    "m": (960, 540, 62),
}


def main():
    for key in VARIANTS:
        os.makedirs(os.path.join(OUT, key), exist_ok=True)

    manifest = {"version": 1, "source": "every %dnd frame of Video1-5" % STEP, "variants": {}, "sequences": []}
    for key, (w, h, _) in VARIANTS.items():
        manifest["variants"][key] = {"width": w, "height": h}

    n = 0
    total_bytes = {k: 0 for k in VARIANTS}
    for seq, label, video, first, last in SEQUENCES:
        path = os.path.join(VIDEOS, video)
        cap = cv2.VideoCapture(path)
        if not cap.isOpened():
            sys.exit(f"Cannot open {path}")
        start_index = n
        frames = {k: [] for k in VARIANTS}
        for idx in range(first, last + 1, STEP):
            cap.set(cv2.CAP_PROP_POS_FRAMES, idx)
            ok, frame = cap.read()
            if not ok:
                sys.exit(f"{video}: could not read frame {idx}")
            # Very light edge-preserving smoothing: removes video grain that
            # compresses badly, without softening the food.
            frame = cv2.bilateralFilter(frame, 5, 20, 5)
            img = Image.fromarray(cv2.cvtColor(frame, cv2.COLOR_BGR2RGB))
            n += 1
            name = f"{n:04d}.webp"
            for key, (w, h, q) in VARIANTS.items():
                dest = os.path.join(OUT, key, name)
                img.resize((w, h), Image.LANCZOS).save(dest, "WEBP", quality=q, method=6)
                total_bytes[key] += os.path.getsize(dest)
                frames[key].append(f"/frames/smooth/{key}/{name}")
        cap.release()
        manifest["sequences"].append({
            "sequence": seq,
            "label": label,
            "startIndex": start_index,
            "frameCount": n - start_index,
            "frames": frames["d"],
            "framesMobile": frames["m"],
        })
        print(f"  {seq}. {label:22s} {n - start_index:3d} frames  ({video} {first}-{last})")

    manifest["totalFrames"] = n
    manifest["width"], manifest["height"] = VARIANTS["d"][0], VARIANTS["d"][1]
    with open(os.path.join(PROJECT, "public", "frames", "manifest-smooth.json"), "w", encoding="utf-8") as fh:
        json.dump(manifest, fh, indent=2)
        fh.write("\n")
    for key, b in total_bytes.items():
        print(f"variant {key}: {b / 1048576:.1f} MB")
    print(f"Wrote {n} frames + public/frames/manifest-smooth.json")


if __name__ == "__main__":
    main()

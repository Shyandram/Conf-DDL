#!/usr/bin/env python3
"""Depth maps for the city scenes, so the page can give the panoramas a little 2.5D parallax.

For every city in data/cities.json with a day scene, estimates relative depth with Depth Anything V2 Small
(ONNX, run on the CPU with onnxruntime) and writes assets/scenes/<slug>/depth.webp: grey, near = white,
at a quarter of the scene's size (depth is smooth; the page samples it with linear filtering). The dawn,
dusk and night pictures are edits of the day one with the same layout, so one map serves all four.
The map is listed as "depth" (with a ?v= content hash) next to the city's "scenes".

  pip install onnxruntime pillow numpy
  python3 scripts/gen_depth.py            # cities whose map is missing or older than their day scene
  python3 scripts/gen_depth.py --all      # every city again
  python3 scripts/gen_depth.py Kyoto Rome # just these
"""
import hashlib
import json
import sys
import urllib.request
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
CITIES = ROOT / "data" / "cities.json"
MODEL_URL = "https://huggingface.co/onnx-community/depth-anything-v2-small/resolve/main/onnx/model.onnx"
MODEL = Path.home() / ".cache" / "confddl" / "depth-anything-v2-small.onnx"
MEAN, STD = np.array([0.485, 0.456, 0.406], np.float32), np.array([0.229, 0.224, 0.225], np.float32)
IN_H = 518  # the model's native height; the width keeps the panorama's shape, rounded to a multiple of 14


def session():
    import onnxruntime as ort
    if not MODEL.exists():
        MODEL.parent.mkdir(parents=True, exist_ok=True)
        print("downloading the depth model…", flush=True)
        urllib.request.urlretrieve(MODEL_URL, MODEL)
    return ort.InferenceSession(str(MODEL), providers=["CPUExecutionProvider"])


def depth_of(sess, img):
    w = round(img.width * IN_H / img.height / 14) * 14
    x = np.asarray(img.convert("RGB").resize((w, IN_H), Image.BICUBIC), np.float32) / 255
    x = ((x - MEAN) / STD).transpose(2, 0, 1)[None]
    d = sess.run(None, {sess.get_inputs()[0].name: x})[0][0]  # relative inverse depth: larger = nearer
    lo, hi = np.percentile(d, 1), np.percentile(d, 99.5)
    d = np.clip((d - lo) / max(hi - lo, 1e-6), 0, 1)
    out = Image.fromarray((d * 255).astype(np.uint8)).resize((img.width // 4, img.height // 4), Image.BICUBIC)
    return out.filter(ImageFilter.GaussianBlur(1.2))  # soft edges: no tearing where near meets far


def main():
    args = sys.argv[1:]
    redo_all = "--all" in args
    only = {a for a in args if not a.startswith("--")}
    cities = json.loads(CITIES.read_text())
    sess = None
    done = 0
    for name, c in cities.items():
        day = (c.get("scenes") or {}).get("day")
        if not day or (only and name not in only):
            continue
        src = ROOT / day.split("?")[0]
        dst = src.with_name("depth.webp")
        if not src.exists():
            continue
        if not redo_all and not only and dst.exists() and c.get("depth") and dst.stat().st_mtime >= src.stat().st_mtime:
            continue
        sess = sess or session()
        depth_of(sess, Image.open(src)).save(dst, "WEBP", quality=82, method=6)
        h = hashlib.sha1(dst.read_bytes()).hexdigest()[:8]
        c["depth"] = f"{dst.relative_to(ROOT).as_posix()}?v={h}"
        done += 1
        print(f"{name}: {dst.relative_to(ROOT)} ({dst.stat().st_size // 1024} KB)", flush=True)
    CITIES.write_text(json.dumps(cities, ensure_ascii=False, indent=2) + "\n")
    print(f"{done} depth map(s)")


if __name__ == "__main__":
    main()

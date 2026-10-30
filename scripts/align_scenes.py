#!/usr/bin/env python3
"""Line the dawn, dusk and night scenes up with the day one, so the page can blend them without ghosting.

The three moods are image-model edits of the day picture: same layout, but often shifted, scaled or tilted by
a few to a few dozen pixels. The page cross-fades them by the clock and shares one depth map between them, so
any drift shows as doubled roofs. For every mood this script:

  0. masks out the sky with the city's depth map (clouds change between moods, so only the ground counts);
  1. finds a similarity transform (shift, scale, rotation) from SIFT features matched with RANSAC, on
     contrast-equalised greys (the night picture is dark, its lights differ, so raw pixels don't match);
  2. also fits affines to a grid of local phase-correlation shifts and with ECC on edge maps, and keeps
     whichever transform leaves the least local drift;
  3. adds a smooth local displacement field from the remaining tile shifts, for edits that moved one part of
     the picture (a taller tower, a shifted ridge) and not the rest;
  4. warps the mood into the day picture's frame (mirrored at the borders) and saves it as WebP in place.

Colours are untouched: only the geometry changes. Pictures already within 1.5 px are left
as they are, so a second run is a no-op. Each changed mood gets a new ?v= hash in data/cities.json.

  pip install opencv-python-headless numpy pillow
  python3 scripts/align_scenes.py              # every city
  python3 scripts/align_scenes.py Kyoto Rome   # just these
  python3 scripts/align_scenes.py --check      # report the drift, change nothing
"""
import hashlib
import json
import sys
import warnings
from pathlib import Path

import cv2
import numpy as np

ROOT = Path(__file__).resolve().parent.parent
CITIES = ROOT / "data" / "cities.json"
MOODS = ("dawn", "dusk", "night")
WORK_W = 1200  # alignment runs at half size; the transform is scaled back up


def grey(path):
    g = cv2.imread(str(path), cv2.IMREAD_GRAYSCALE)
    return cv2.createCLAHE(3.0, (8, 8)).apply(g)


def edges(g):
    g = g.astype(np.float32)
    m = cv2.GaussianBlur(np.hypot(cv2.Sobel(g, -1, 1, 0), cv2.Sobel(g, -1, 0, 1)), (0, 0), 1.5)
    return m / (m.std() + 1e-6)


def corr(a, b):
    a, b = a - a.mean(), b - b.mean()
    return float((a * b).sum() / (np.sqrt((a * a).sum() * (b * b).sum()) + 1e-9))


def features(ref, mov):
    """Similarity transform mapping day coordinates to mood coordinates, from matched features (or None)."""
    det = cv2.SIFT_create(4000)
    k1, d1 = det.detectAndCompute(ref, None)
    k2, d2 = det.detectAndCompute(mov, None)
    if d1 is None or d2 is None or len(k1) < 12 or len(k2) < 12:
        return None
    pairs = cv2.BFMatcher(cv2.NORM_L2).knnMatch(d1, d2, k=2)
    good = [m for m, n in (p for p in pairs if len(p) == 2) if m.distance < .8 * n.distance]
    if len(good) < 12:
        return None
    src = np.float32([k1[m.queryIdx].pt for m in good])
    dst = np.float32([k2[m.trainIdx].pt for m in good])
    warp, inl = cv2.estimateAffinePartial2D(src, dst, method=cv2.RANSAC, ransacReprojThreshold=3, maxIters=5000)
    if warp is None or inl.sum() < 10:
        return None
    return warp.astype(np.float32)


def ecc(ref, mov, warp):
    """Refine warp (day → mood coordinates) as a full affine on edge maps, coarse to fine."""
    for f in (.25, .5, 1):
        r = cv2.resize(ref, None, fx=f, fy=f, interpolation=cv2.INTER_AREA)
        m = cv2.resize(mov, None, fx=f, fy=f, interpolation=cv2.INTER_AREA)
        w = warp.copy(); w[:, 2] *= f
        try:
            _, w = cv2.findTransformECC(r, m, w, cv2.MOTION_AFFINE,
                                        (cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 150, 1e-6), None, 5)
        except cv2.error:
            return None
        w[:, 2] /= f
        warp = w
    return warp


def sane(w, width):
    a = w[:, :2]
    s = np.sqrt(abs(np.linalg.det(a)))
    rot = np.degrees(np.arctan2(a[1, 0], a[0, 0]))
    return .9 < s < 1.1 and abs(rot) < 3 and np.abs(w[:, 2]).max() < .08 * width


TILE, STEP = 96, 24
HANN = cv2.createHanningWindow((TILE, TILE), cv2.CV_32F)


SKY = None  # working-size mask of the sky (from the depth map) for the city being aligned


def tiles(ref, mov):
    """Local shifts of mov against ref on a grid of tiles: arrays dx, dy (NaN where nothing to lock onto).
    Sky tiles are skipped: clouds differ from one mood to the next, so they would only pull the picture apart."""
    h, w = ref.shape
    ys, xs = range(0, h - TILE + 1, STEP), range(0, w - TILE + 1, STEP)
    dx, dy = np.full((len(ys), len(xs)), np.nan, np.float32), np.full((len(ys), len(xs)), np.nan, np.float32)
    for i, y in enumerate(ys):
        for j, x in enumerate(xs):
            r = ref[y:y + TILE, x:x + TILE]
            if r.std() < .35 or (SKY is not None and SKY[y:y + TILE, x:x + TILE].mean() > .4):
                continue
            # copies: phaseCorrelate applies the window to its inputs in place
            (sx, sy), resp = cv2.phaseCorrelate(r.copy(), mov[y:y + TILE, x:x + TILE].copy(), HANN)
            if resp > .08 and abs(sx) < TILE / 3 and abs(sy) < TILE / 3:
                dx[i, j], dy[i, j] = sx, sy
    return dx, dy


def residual(ref, mov):
    """Median local misalignment (px at working size) and how many tiles could be measured."""
    dx, dy = tiles(ref, mov)
    d = np.hypot(dx, dy)[~np.isnan(dx)]
    return (float(np.median(d)), d.size) if d.size >= 24 else (None, d.size)


def ident(shape):
    h, w = shape
    return np.meshgrid(np.arange(w, dtype=np.float32), np.arange(h, dtype=np.float32))


def remap(img, mx, my):
    return cv2.remap(img, mx, my, cv2.INTER_LINEAR, borderMode=cv2.BORDER_REFLECT101)


def dremap(d, mx, my):
    return cv2.remap(d, mx, my, cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)


def affine_maps(w, shape):
    x, y = ident(shape)
    return w[0, 0] * x + w[0, 1] * y + w[0, 2], w[1, 0] * x + w[1, 1] * y + w[1, 2]


def from_tiles(ref, mov, warp=None):
    """Full affine (day → mood coordinates) fitted with RANSAC to the tile shifts."""
    h, w = ref.shape
    cy, cx = np.mgrid[TILE / 2:h - TILE / 2 + 1:STEP, TILE / 2:w - TILE / 2 + 1:STEP].astype(np.float32)
    for _ in range(3):
        dx, dy = tiles(ref, mov if warp is None else remap(mov, *affine_maps(warp, ref.shape)))
        ok = ~np.isnan(dx)
        if ok.sum() < 24:
            return warp
        src = np.stack([cx[ok], cy[ok]], 1)
        dst = src + np.stack([dx[ok], dy[ok]], 1)
        if warp is not None:
            dst = np.c_[dst, np.ones(len(dst), np.float32)] @ warp.T
        a, inl = cv2.estimateAffine2D(src, dst.astype(np.float32), method=cv2.RANSAC, ransacReprojThreshold=1.5, maxIters=4000)
        if a is None or inl.sum() < 20:
            return warp
        warp = a.astype(np.float32)
    return warp


def nanfilter(g, r=2):
    """Median over a (2r+1)² window, ignoring NaN; then NaN holes filled by normalised Gaussian smoothing."""
    p = np.pad(g, r, mode="constant", constant_values=np.nan)
    win = np.lib.stride_tricks.sliding_window_view(p, (2 * r + 1, 2 * r + 1))
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", RuntimeWarning)  # all-NaN windows
        med = np.nanmedian(win.reshape(*g.shape, -1), axis=2)
    # outliers (far from the neighbourhood's median) count as missing
    m = np.where(np.isnan(g) | (np.abs(g - med) > 2), np.nan, g)
    ok = (~np.isnan(m)).astype(np.float32)
    out = np.zeros_like(g)
    hole = np.ones(g.shape, bool)
    for sigma in (1.5, 4, 10, 30):  # wider and wider, so empty sky takes the shift of what's around it
        num = cv2.GaussianBlur(np.nan_to_num(m), (0, 0), sigma, borderType=cv2.BORDER_REPLICATE)
        den = cv2.GaussianBlur(ok, (0, 0), sigma, borderType=cv2.BORDER_REPLICATE)
        fill = hole & (den > 1e-3)
        out[fill] = num[fill] / den[fill]
        hole &= ~fill
    out[hole] = np.nanmedian(m) if ok.any() else 0
    return out


def flow(ref, mov, mx, my):
    """Refine maps with a smooth local displacement field from the tile shifts (for non-rigid edits)."""
    h, w = ref.shape
    for _ in range(3):
        dx, dy = tiles(ref, remap(mov, mx, my))
        if (~np.isnan(dx)).sum() < 24:
            break
        # the grid's cells sit at tile centres: spread them over the working picture
        fx = cv2.resize(nanfilter(dx), None, fx=STEP, fy=STEP, interpolation=cv2.INTER_CUBIC)
        fy = cv2.resize(nanfilter(dy), None, fx=STEP, fy=STEP, interpolation=cv2.INTER_CUBIC)
        pad = ((TILE // 2 - STEP // 2, h), (TILE // 2 - STEP // 2, w))
        fx = cv2.copyMakeBorder(fx, pad[0][0], 0, pad[1][0], 0, cv2.BORDER_REPLICATE)
        fy = cv2.copyMakeBorder(fy, pad[0][0], 0, pad[1][0], 0, cv2.BORDER_REPLICATE)
        fx = cv2.copyMakeBorder(fx, 0, max(0, h - fx.shape[0]), 0, max(0, w - fx.shape[1]), cv2.BORDER_REPLICATE)[:h, :w]
        fy = cv2.copyMakeBorder(fy, 0, max(0, h - fy.shape[0]), 0, max(0, w - fy.shape[1]), cv2.BORDER_REPLICATE)[:h, :w]
        fx = cv2.GaussianBlur(fx, (0, 0), STEP); fy = cv2.GaussianBlur(fy, (0, 0), STEP)
        # compose as displacements (replicated at the borders, unlike absolute coordinates, which a mirror breaks)
        x, y = ident(ref.shape)
        mx = x + fx + dremap(mx - x, x + fx, y + fy)
        my = y + fy + dremap(my - y, x + fx, y + fy)
    return mx, my


def align(day_path, mood_path, depth_path=None):
    """(full-size maps day → mood, local misalignment before, after, in full-size px) or None."""
    global SKY
    full = cv2.imread(str(day_path), cv2.IMREAD_GRAYSCALE).shape
    k = WORK_W / full[1]
    SKY = None
    if depth_path and Path(depth_path).exists():  # Depth Anything puts the sky at 0
        d = cv2.imread(str(depth_path), cv2.IMREAD_GRAYSCALE)
        SKY = cv2.resize(d, (WORK_W, round(full[0] * k)), interpolation=cv2.INTER_LINEAR) < 2
    ref_g = cv2.resize(grey(day_path), None, fx=k, fy=k, interpolation=cv2.INTER_AREA)
    mov_g = cv2.resize(grey(mood_path), None, fx=k, fy=k, interpolation=cv2.INTER_AREA)
    if mov_g.shape != ref_g.shape:
        mov_g = cv2.resize(mov_g, ref_g.shape[::-1], interpolation=cv2.INTER_AREA)
    ref, mov = edges(ref_g), edges(mov_g)
    before, n = residual(ref, mov)
    if before is None:
        return None
    # 1. a global affine: from the tile shifts, from SIFT features, or ECC; whichever leaves the least drift
    cands = [np.eye(2, 3, dtype=np.float32)]
    f = features(ref_g, mov_g)
    for init in (None, f if f is not None and sane(f, WORK_W) else None):
        w = from_tiles(ref, mov, init)
        if w is not None:
            cands.append(w)
        if init is not None:
            cands.append(init)
    e = ecc(ref, mov, np.eye(2, 3, dtype=np.float32))
    if e is not None:
        cands.append(e)
    best = None
    for w in cands:
        if not sane(w, WORK_W):
            continue
        r, m = residual(ref, remap(mov, *affine_maps(w, ref.shape)))
        if r is not None and m >= .6 * n and (best is None or r < best[1]):
            best = (w, r)
    # 2. a smooth local field on top, for edits that moved one part of the picture and not the rest
    mx, my = flow(ref, mov, *affine_maps(best[0], ref.shape))
    after, m = residual(ref, remap(mov, mx, my))
    if after is None or m < .6 * n or after > best[1]:
        mx, my = affine_maps(best[0], ref.shape)
        after = best[1]
    if after > before - .1:
        return None
    # to full size: full pixel P sits at (P + .5) k - .5 in the working picture
    X, Y = ident(full)
    wx, wy = (X + .5) * k - .5, (Y + .5) * k - .5
    x, y = ident(ref.shape)
    MX = X + dremap(mx - x, wx, wy) / k
    MY = Y + dremap(my - y, wx, wy) / k
    return (MX, MY), before / k, after / k


def main():
    args = sys.argv[1:]
    check = "--check" in args
    only = {a for a in args if not a.startswith("--")}
    cities = json.loads(CITIES.read_text())
    changed = 0
    for name, c in cities.items():
        sc = c.get("scenes") or {}
        if not sc.get("day") or (only and name not in only):
            continue
        day = ROOT / sc["day"].split("?")[0]
        if not day.exists():
            continue
        notes = []
        for m in MOODS:
            if not sc.get(m):
                continue
            path = ROOT / sc[m].split("?")[0]
            if not path.exists():
                continue
            img = cv2.imread(str(path), cv2.IMREAD_COLOR)
            size = cv2.imread(str(day), cv2.IMREAD_GRAYSCALE).shape
            if img.shape[:2] != size:  # a mood saved at another size: work in the day's frame
                img = cv2.resize(img, size[::-1], interpolation=cv2.INTER_AREA)
            res = align(day, path, c.get("depth") and ROOT / c["depth"].split("?")[0])
            if res is None:
                notes.append(f"{m}: ok")
                continue
            (mx, my), before, after = res
            X, Y = ident(size)
            d = float(np.percentile(np.hypot(mx - X, my - Y), 99))
            if d < 1.5:  # under a pixel and a half: not worth a re-encode
                notes.append(f"{m}: ok")
                continue
            notes.append(f"{m}: moved up to {d:.1f}px, local drift {before:.1f}→{after:.1f}px")
            if check:
                continue
            out = cv2.remap(img, mx, my, cv2.INTER_LANCZOS4, borderMode=cv2.BORDER_REFLECT101)
            cv2.imwrite(str(path), out, [cv2.IMWRITE_WEBP_QUALITY, 80])
            sc[m] = f"{path.relative_to(ROOT).as_posix()}?v={hashlib.sha1(path.read_bytes()).hexdigest()[:8]}"
            changed += 1
        print(f"{name}: " + "; ".join(notes), flush=True)
    if not check:
        CITIES.write_text(json.dumps(cities, ensure_ascii=False, indent=2) + "\n")
    print("checked" if check else f"{changed} picture(s) aligned")


if __name__ == "__main__":
    main()

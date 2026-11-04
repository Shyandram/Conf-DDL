#!/usr/bin/env python3
"""Draws the home-screen icons (assets/icons/) from the favicon's design: a lime clock face on near-black.

  icon-180.png   apple-touch-icon (iOS rounds the corners itself)
  icon-192.png, icon-512.png    manifest icons
  icon-maskable-512.png         Android adaptive icon: the clock kept inside the 80% safe zone

Needs Pillow. Rerun only when the design changes.
"""
from pathlib import Path

from PIL import Image, ImageDraw

BG, FG = (10, 12, 16), (212, 255, 58)
OUT = Path(__file__).resolve().parent.parent / "assets" / "icons"
SS = 4  # supersampling for smooth edges


def draw(size, scale):
    """scale = clock radius as a share of the icon (the favicon uses 9/32)."""
    n = size * SS
    im = Image.new("RGB", (n, n), BG)
    d = ImageDraw.Draw(im)
    c, r, w = n / 2, n * scale, n * scale * 2.5 / 9
    d.ellipse([c - r, c - r, c + r, c + r], outline=FG, width=round(w))
    # hands: up to 12, then toward 4 o'clock, as in the favicon (M16 10v6l4 3 on a radius of 9)
    u = r / 9
    pts = [(c, c - 6 * u), (c, c), (c + 4 * u, c + 3 * u)]
    d.line(pts, fill=FG, width=round(w), joint="curve")
    for x, y in (pts[0], pts[2]):
        d.ellipse([x - w / 2, y - w / 2, x + w / 2, y + w / 2], fill=FG)
    return im.resize((size, size), Image.LANCZOS)


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    for size in (180, 192, 512):
        draw(size, 0.30).save(OUT / f"icon-{size}.png", optimize=True)
    draw(512, 0.24).save(OUT / "icon-maskable-512.png", optimize=True)
    print("wrote", ", ".join(sorted(p.name for p in OUT.glob("*.png"))))


if __name__ == "__main__":
    main()

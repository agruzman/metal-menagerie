#!/usr/bin/env python3
"""
process_photos.py — turns phone snapshots of the sculptures into consistent,
catalogue-ready product photos.

For every photo:
  1. find the sculpture (GrabCut segmentation, seeded with a centred box or a
     per-photo box from catalog.json),
  2. crop to a square around it with even padding,
  3. calm the background down (soft blur, a little darker and less saturated —
     a "portrait mode" look that hides workshop clutter),
  4. lift the sculpture itself (contrast, sharpness),
  5. add a gentle vignette and save at 1400×1400.

Usage:
  python3 tools/process_photos.py            # all photos in catalog.json
  python3 tools/process_photos.py 12 38      # only these indexes (for tuning)

Needs Pillow, numpy and opencv-python (cv2). Reads src/catalog.json.
"""
import json
import os
import sys

import cv2
import numpy as np
from PIL import Image, ImageEnhance, ImageFilter, ImageOps

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SRC = os.path.join(ROOT, "products")
OUT = os.path.join(ROOT, "public", "uploads")
SIZE = 1400
ASPECTS = {"square": (1400, 1400), "portrait": (1120, 1400), "landscape": (1400, 1120)}


def load(path):
    im = ImageOps.exif_transpose(Image.open(path)).convert("RGB")
    return im


def grabcut_mask(im, box, iters=6, work=900):
    """Foreground mask (0..1 float, full resolution) for the object inside `box`
    (fractions of width/height: x0, y0, x1, y1)."""
    w, h = im.size
    scale = work / max(w, h)
    small = im.resize((max(1, int(w * scale)), max(1, int(h * scale))), Image.LANCZOS)
    arr = cv2.cvtColor(np.array(small), cv2.COLOR_RGB2BGR)
    sw, sh = small.size
    x0, y0, x1, y1 = box
    rect = (int(x0 * sw), int(y0 * sh), int((x1 - x0) * sw), int((y1 - y0) * sh))

    mask = np.zeros((sh, sw), np.uint8)
    bgd = np.zeros((1, 65), np.float64)
    fgd = np.zeros((1, 65), np.float64)
    cv2.grabCut(arr, mask, rect, bgd, fgd, iters, cv2.GC_INIT_WITH_RECT)
    fg = np.where((mask == cv2.GC_FGD) | (mask == cv2.GC_PR_FGD), 255, 0).astype(np.uint8)

    # Keep the main body plus any parts of decent size (legs, whiskers), drop specks.
    n, labels, stats, _ = cv2.connectedComponentsWithStats(fg, connectivity=8)
    if n > 1:
        areas = stats[1:, cv2.CC_STAT_AREA]
        biggest = areas.max()
        keep = np.zeros_like(fg)
        for i, a in enumerate(areas, start=1):
            if a >= max(60, biggest * 0.01):
                keep[labels == i] = 255
        fg = keep
    # close small holes (reflections inside the metal)
    fg = cv2.morphologyEx(fg, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (7, 7)))
    fg = cv2.resize(fg, (w, h), interpolation=cv2.INTER_LINEAR)
    return fg.astype(np.float32) / 255.0



def fit_aspect(x0, y0, x1, y1, w, h, ratio, min_frac=0.35):
    """Smallest box with the given width/height ratio that contains the
    rectangle, kept inside the image and not smaller than min_frac of it."""
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    bw, bh = max(x1 - x0, 1), max(y1 - y0, 1)
    cw = max(bw, bh * ratio, min(w, h) * min_frac)
    ch = cw / ratio
    if cw > w:
        cw, ch = w, w / ratio
    if ch > h:
        ch, cw = h, h * ratio
    left = int(round(min(max(cx - cw / 2, 0), w - cw)))
    top = int(round(min(max(cy - ch / 2, 0), h - ch)))
    return left, top, int(round(cw)), int(round(ch))


def vignette(tw, th, strength=0.28):
    yy, xx = np.mgrid[0:th, 0:tw].astype(np.float32)
    d = np.sqrt(((xx - tw / 2) / (tw / 2)) ** 2 + ((yy - th / 2) / (th / 2)) ** 2) / 1.35
    v = 1 - strength * np.clip(d, 0, 1) ** 2.2
    return v[..., None]


def process(entry, index):
    src = os.path.join(SRC, entry["file"])
    im = load(src)
    w, h = im.size
    box = entry.get("box", [0.10, 0.08, 0.90, 0.92])
    mask = grabcut_mask(im, box)

    aspect = entry.get("aspect", "square")
    TW, TH = ASPECTS[aspect]
    if entry.get("crop"):
        # Manual override: fractions x0, y0, x1, y1 of the original photo.
        cx0, cy0, cx1, cy1 = entry["crop"]
        rx0, ry0, rx1, ry1 = cx0 * w, cy0 * h, cx1 * w, cy1 * h
    else:
        ys, xs = np.where(mask > 0.5)
        pad = entry.get("pad", 0.16)
        if len(xs) < 50:
            rx0, ry0, rx1, ry1 = w * 0.1, h * 0.1, w * 0.9, h * 0.9
        else:
            bw, bh = xs.max() - xs.min(), ys.max() - ys.min()
            rx0, rx1 = xs.min() - bw * pad, xs.max() + bw * pad
            ry0, ry1 = ys.min() - bh * pad, ys.max() + bh * pad
    left, top, cw, ch = fit_aspect(rx0, ry0, rx1, ry1, w, h, TW / TH, min_frac=0.35)
    im_c = im.crop((left, top, left + cw, top + ch)).resize((TW, TH), Image.LANCZOS)
    m = cv2.resize(mask[top:top + ch, left:left + cw], (TW, TH), interpolation=cv2.INTER_LINEAR)

    # The segmentation is never perfect (it likes to keep the table the piece
    # stands on), so the sharp/soft transition is made very gradual and is
    # combined with a radial falloff: sharp in the middle, soft at the edges.
    # Errors then disappear under a smooth gradient instead of showing as a
    # sharp-edged patch.
    m = cv2.GaussianBlur(m, (0, 0), TW * 0.02)
    yy, xx = np.mgrid[0:TH, 0:TW].astype(np.float32)
    r = np.sqrt(((xx - TW / 2) / (TW / 2)) ** 2 + ((yy - TH / 2) / (TH / 2)) ** 2)
    radial = np.clip(1 - (r - 0.42) / 0.38, 0, 1)
    m = np.clip(np.maximum(m, radial * 0.9), 0, 1)[..., None]

    # --- background: calm it down (more so when it is busy) ---
    busy = entry.get("busy", 1.0)
    bg = im_c.filter(ImageFilter.GaussianBlur(TW * 0.005 * busy))
    bg = ImageEnhance.Color(bg).enhance(0.70 / busy)
    bg = ImageEnhance.Brightness(bg).enhance(0.84 / (busy ** 0.5))
    bg = ImageEnhance.Contrast(bg).enhance(0.90)

    # --- subject: lift it ---
    fg = ImageEnhance.Contrast(im_c).enhance(1.10)
    fg = ImageEnhance.Color(fg).enhance(1.06)
    fg = fg.filter(ImageFilter.UnsharpMask(radius=2.2, percent=85, threshold=3))

    out = np.array(fg).astype(np.float32) * m + np.array(bg).astype(np.float32) * (1 - m)
    out = out * vignette(TW, TH, strength=0.22 + 0.1 * (busy - 1))
    out = np.clip(out, 0, 255).astype(np.uint8)
    result = Image.fromarray(out)

    # gentle global auto-levels so dark workshop shots don't look muddy
    result = ImageOps.autocontrast(result, cutoff=0.4, preserve_tone=True)

    os.makedirs(OUT, exist_ok=True)
    dest = os.path.join(OUT, entry["image"])
    result.save(dest, quality=88, optimize=True, progressive=True)
    return dest, (left, top, cw, ch), float(mask.mean())


def main():
    catalog = json.load(open(os.path.join(ROOT, "src", "catalog.json")))
    wanted = {int(a) for a in sys.argv[1:]} if len(sys.argv) > 1 else None
    for i, entry in enumerate(catalog["photos"]):
        if wanted is not None and i not in wanted:
            continue
        if not entry.get("image") or entry.get("manual"):
            continue  # "manual": finished by hand, leave it alone
        dest, crop, cover = process(entry, i)
        print(f"#{i:02d} {entry['image']:<32} crop={crop} subject={cover:.0%}")


if __name__ == "__main__":
    main()

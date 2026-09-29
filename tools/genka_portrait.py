#!/usr/bin/env python3
"""
genka_portrait.py — the "at work" portrait: Genka sharp, the workshop melted
into a deep cool blur, a little arc-light at the electrode. Slightly
futuristic, still obviously a real welder in a real shop.

  python3 tools/genka_portrait.py

Reads products/"Genka at work.jpeg", writes public/uploads/genka-welding.jpg
(+ the -sm thumbnail). The segmentation is seeded by hand (the polygons
below), because a plain box grabbed the pillar and the chair along with him.
"""
import os

import cv2
import numpy as np
from PIL import Image, ImageEnhance, ImageFilter, ImageOps

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "products", "Genka at work.jpeg")
OUT = os.path.join(ROOT, "public", "uploads", "genka-welding.jpg")

BLUR = 0.045          # background blur radius as a fraction of the width
TINT_STRENGTH = 0.32  # how blue the shop goes

im = ImageOps.exif_transpose(Image.open(SRC)).convert("RGB")
w, h = im.size
ch = int(w * 5 / 4)                                  # 4:5 crop, full width
top = max(0, min(int(h * 0.45 - ch / 2), h - ch))    # helmet to boots
im = im.crop((0, top, w, top + ch))
W, H = im.size
arr = cv2.cvtColor(np.array(im), cv2.COLOR_RGB2BGR)
lum = cv2.cvtColor(arr, cv2.COLOR_BGR2GRAY)

# ------------------------------------------------------------ segmentation
P = lambda x, y: (int(x * W), int(y * H))
poly = lambda pts: np.array([P(*p) for p in pts], np.int32)

mask = np.full((H, W), cv2.GC_PR_BGD, np.uint8)
# a generous silhouette: probably him
cv2.fillPoly(mask, [poly([(.40, .10), (.56, .10), (.60, .20), (.72, .32), (.76, .50), (.70, .55), (.62, .56),
                          (.58, .62), (.58, .86), (.56, .96), (.40, .96), (.38, .80), (.37, .62), (.30, .56),
                          (.26, .48), (.30, .36), (.36, .24)])], cv2.GC_PR_FGD)
# certainly him: helmet, torso, legs, both gloves
cv2.circle(mask, P(.47, .21), int(W * .055), cv2.GC_FGD, -1)
cv2.fillPoly(mask, [poly([(.36, .30), (.62, .30), (.64, .52), (.42, .54)])], cv2.GC_FGD)
cv2.fillPoly(mask, [poly([(.42, .58), (.48, .58), (.475, .90), (.44, .90)])], cv2.GC_FGD)  # his left leg only
cv2.circle(mask, P(.33, .47), int(W * .03), cv2.GC_FGD, -1)
cv2.circle(mask, P(.66, .50), int(W * .03), cv2.GC_FGD, -1)
# certainly the shop: edges, pillar, table, floor, chair
cv2.rectangle(mask, P(0, 0), P(1, .07), cv2.GC_BGD, -1)
cv2.rectangle(mask, P(0, 0), P(.20, 1), cv2.GC_BGD, -1)
cv2.rectangle(mask, P(.80, 0), P(1, 1), cv2.GC_BGD, -1)
cv2.fillPoly(mask, [poly([(.57, .07), (.80, .07), (.80, .30), (.66, .30), (.60, .18)])], cv2.GC_BGD)
cv2.fillPoly(mask, [poly([(.62, .60), (1, .52), (1, 1), (.60, 1)])], cv2.GC_BGD)
cv2.fillPoly(mask, [poly([(0, .70), (.36, .66), (.40, 1), (0, 1)])], cv2.GC_BGD)
cv2.fillPoly(mask, [poly([(.20, .36), (.30, .36), (.29, .44), (.29, .52), (.35, .60), (.36, .66), (.20, .68)])], cv2.GC_BGD)
# the box of hooks on the pillar behind his helmet
cv2.fillPoly(mask, [poly([(.20, .07), (.41, .07), (.395, .14), (.375, .24), (.36, .30), (.20, .30)])], cv2.GC_BGD)
# the table corner and ground clamp in front of his legs: light metal is
# table, dark is trousers — let brightness decide
corner = np.zeros((H, W), np.uint8)
cv2.fillPoly(corner, [poly([(.36, .55), (.64, .53), (.67, .72), (.52, .78), (.40, .76)])], 255)
mask[(corner > 0) & (mask != cv2.GC_FGD)] = cv2.GC_PR_BGD
mask[(corner > 0) & (lum > 80) & (mask != cv2.GC_FGD)] = cv2.GC_BGD
# the wedge of table top between his legs (his right leg is behind it)
cv2.fillPoly(mask, [poly([(.487, .575), (.60, .555), (.62, .70), (.545, .74), (.49, .67)])], cv2.GC_BGD)

bgd = np.zeros((1, 65), np.float64)
fgd = np.zeros((1, 65), np.float64)
cv2.grabCut(arr, mask, None, bgd, fgd, 10, cv2.GC_INIT_WITH_MASK)
fg = np.where((mask == cv2.GC_FGD) | (mask == cv2.GC_PR_FGD), 255, 0).astype(np.uint8)
n, labels, stats, _ = cv2.connectedComponentsWithStats(fg, connectivity=8)
if n > 1:
    biggest = 1 + int(np.argmax(stats[1:, cv2.CC_STAT_AREA]))
    fg = np.where(labels == biggest, 255, 0).astype(np.uint8)
fg = cv2.morphologyEx(fg, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (21, 21)))
inv = cv2.bitwise_not(fg)
n2, l2, s2, _ = cv2.connectedComponentsWithStats(inv, connectivity=4)
for i in range(1, n2):
    x, y, ww, hh, a = s2[i]
    if x > 0 and y > 0 and x + ww < W and y + hh < H and a < W * H * 0.02:
        fg[l2 == i] = 255  # fill enclosed holes (reflections on the helmet etc.)
m = fg.astype(np.float32) / 255.0
m_soft = cv2.GaussianBlur(m, (0, 0), W * 0.005)

# ---------------------------------------------------------------- shop
def graded(blur, sat, bright, tint_strength):
    b = im.filter(ImageFilter.GaussianBlur(W * blur))
    b = ImageEnhance.Color(b).enhance(sat)
    b = ImageEnhance.Brightness(b).enhance(bright)
    b = ImageEnhance.Contrast(b).enhance(0.9)
    a = np.array(b).astype(np.float32)
    tint = np.array([60, 105, 150], np.float32)
    return a * (1 - tint_strength) + tint * tint_strength * (a.mean(axis=2, keepdims=True) / 120.0)

far = graded(BLUR, 0.3, 0.6, TINT_STRENGTH)          # the wall, the pillar, the shelves
near = graded(BLUR * 0.22, 0.55, 0.78, TINT_STRENGTH * 0.5)  # the welding table he leans on
# the table is closer to the camera than he is, so it stays readable
table = np.zeros((H, W), np.float32)
cv2.fillPoly(table, [poly([(.36, .565), (.64, .535), (1, .49), (1, 1), (.50, 1), (.49, .68)])], 1.0)
table = cv2.GaussianBlur(table, (0, 0), W * 0.02)
bg_a = near * table[..., None] + far * (1 - table[..., None])

# ----------------------------------------------------------------- him
fg_im = ImageOps.autocontrast(im, cutoff=0.5, preserve_tone=True)
fg_im = ImageEnhance.Contrast(fg_im).enhance(1.12)
fg_im = ImageEnhance.Color(fg_im).enhance(1.08)
fg_im = fg_im.filter(ImageFilter.UnsharpMask(radius=2.0, percent=90, threshold=3))
fg_a = np.array(fg_im).astype(np.float32)

out = fg_a * m_soft[..., None] + bg_a * (1 - m_soft[..., None])

# cyan rim light along his outline
edge = np.clip(cv2.GaussianBlur(m, (0, 0), W * 0.012) - cv2.GaussianBlur(m, (0, 0), W * 0.003), 0, 1)
out += (edge * 0.9)[..., None] * np.array([120, 220, 255], np.float32) * 0.55

# arc light at the electrode tip, with sparks
yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
tip = (W * 0.615, H * 0.545)
d = np.sqrt((xx - tip[0]) ** 2 + (yy - tip[1]) ** 2)
glow = np.exp(-(d / (W * 0.035)) ** 2) + 0.35 * np.exp(-(d / (W * 0.12)) ** 2)
out += glow[..., None] * np.array([190, 235, 255], np.float32) * 0.9
rng = np.random.default_rng(7)
for _ in range(38):
    ang, r = rng.uniform(0, 2 * np.pi), rng.uniform(W * 0.01, W * 0.11)
    sx, sy = tip[0] + np.cos(ang) * r, tip[1] + np.sin(ang) * r * 0.7 + W * 0.02
    sd = np.sqrt((xx - sx) ** 2 + (yy - sy) ** 2)
    out += np.exp(-(sd / rng.uniform(1.2, 2.6)) ** 2)[..., None] * np.array([255, 225, 160], np.float32) * rng.uniform(0.5, 1.0)

# vignette
dv = np.sqrt(((xx - W / 2) / (W / 2)) ** 2 + ((yy - H / 2) / (H / 2)) ** 2) / 1.3
out *= (1 - 0.3 * np.clip(dv, 0, 1) ** 2.0)[..., None]

result = Image.fromarray(np.clip(out, 0, 255).astype(np.uint8))
result.resize((1120, 1400), Image.LANCZOS).save(OUT, quality=86, optimize=True, progressive=True)
result.resize((480, 600), Image.LANCZOS).save(OUT.replace(".jpg", "-sm.jpg"), quality=82, optimize=True)
print("written", OUT, "— he covers %.0f%% of the frame" % (m.mean() * 100))

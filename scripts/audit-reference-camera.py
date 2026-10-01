"""Independent NumPy replay of a recorded camera's filled triangle outline.
This verifies projected coverage, not the true pose or material correspondence.
"""
import json
import sys
import numpy as np

raw = json.load(open(sys.argv[1], encoding="utf-8"))
p = np.asarray(raw["positions"], dtype=np.float64).reshape(-1, 3)
target = np.asarray(raw["target"], dtype=bool).reshape(96, 96)
center = (p.min(axis=0) + p.max(axis=0)) / 2
extent = (p.max(axis=0) - p.min(axis=0)).max()
def cross(a, b):
    return a[..., 0] * b[..., 1] - a[..., 1] * b[..., 0]

results = {}
for key in ["baseline", "current"]:
    row = raw[key]
    camera = row["camera"]
    yaw, pitch = np.deg2rad([camera["yaw"], camera["pitch"]])
    cy, sy, cp, sp = np.cos(yaw), np.sin(yaw), np.cos(pitch), np.sin(pitch)
    v = p - center
    z = v @ np.array([sy * cp, sp, cy * cp])
    scale = 1 / (1 - camera["perspective"] * z / extent)
    u = (v @ np.array([cy, 0, -sy])) * scale
    w = (v @ np.array([-sy * sp, cp, -cy * sp])) * scale
    bounds = row["bounds"]
    x = (u - bounds[0]) / (bounds[1] - bounds[0]) * 95
    y = (bounds[3] - w) / (bounds[3] - bounds[2]) * 95
    triangles = np.stack([x, y], axis=-1).reshape(-1, 3, 2)
    mask = np.zeros((96, 96), dtype=bool)
    for pts in triangles:
        lo = np.maximum(np.ceil(pts.min(axis=0)).astype(int), 0)
        hi = np.minimum(np.floor(pts.max(axis=0)).astype(int), 95)
        if np.any(lo > hi):
            continue
        a, b, c = pts
        den = cross(b - a, c - a)
        if abs(den) < 1e-8:
            continue
        xx, yy = np.meshgrid(np.arange(lo[0], hi[0] + 1), np.arange(lo[1], hi[1] + 1))
        q = np.stack([xx, yy], axis=-1)
        wa = cross(b - q, c - q) / den
        wb = cross(c - q, a - q) / den
        wc = 1 - wa - wb
        mask[lo[1]:hi[1]+1, lo[0]:hi[0]+1] |= (wa >= -1e-5) & (wb >= -1e-5) & (wc >= -1e-5)
    iou = (mask & target).sum() / max(1, (mask | target).sum())
    aspect = (bounds[1] - bounds[0]) / (bounds[3] - bounds[2])
    penalty = .25 * abs(np.log(aspect / raw["targetAspect"]))
    results[key] = {"silhouetteIoU": float(iou), "aspectPenalty": float(penalty), "score": float(iou - penalty)}
print(json.dumps(results))

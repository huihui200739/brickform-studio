"""Sampled independent 3D ray/triangle intersections for reference-color queries.
No screen-space depth interpolation is used. This is visibility verification,
not pose ground truth, intrinsic paint recognition or exhaustive ray coverage.
"""
import json
import sys
import numpy as np

raw = json.load(open(sys.argv[1], encoding="utf-8"))
p = np.asarray(raw["positions"], dtype=np.float64).reshape(-1, 3)
center = (p.min(axis=0) + p.max(axis=0)) / 2
extent = (p.max(axis=0) - p.min(axis=0)).max()
camera = raw["camera"]
yaw, pitch = np.deg2rad([camera["yaw"], camera["pitch"]])
cy, sy, cp, sp = np.cos(yaw), np.sin(yaw), np.cos(pitch), np.sin(pitch)
basis = np.array([[cy, 0, -sy], [-sy * sp, cp, -cy * sp], [sy * cp, sp, cy * cp]])
tri = ((p - center) @ basis.T).reshape(-1, 3, 3)
a = tri[:, 0]
e1, e2 = tri[:, 1] - a, tri[:, 2] - a
normal = np.cross(e1, e2)
plane = np.einsum('ij,ij->i', normal, a)
d00 = np.einsum('ij,ij->i', e1, e1)
d01 = np.einsum('ij,ij->i', e1, e2)
d11 = np.einsum('ij,ij->i', e2, e2)
den = d00 * d11 - d01 * d01
bounds = raw['bounds']
failures = []
max_residual = 0.0
by_kind = {}
for q in raw['queries']:
    u = bounds[0] + q['x'] / 191 * (bounds[1] - bounds[0])
    v = bounds[3] - q['y'] / 191 * (bounds[3] - bounds[2])
    if camera['perspective']:
        distance = extent / camera['perspective']
        origin, direction = np.array([0, 0, distance]), np.array([u, v, -distance])
    else:
        origin = np.array([u, v, tri[:, :, 2].max() + extent])
        direction = np.array([0., 0., -1.])
    with np.errstate(divide='ignore', invalid='ignore'):
        t = (plane - normal @ origin) / (normal @ direction)
        delta = origin + t[:, None] * direction - a
        dot1 = np.einsum('ij,ij->i', delta, e1)
        dot2 = np.einsum('ij,ij->i', delta, e2)
        b = (d11 * dot1 - d01 * dot2) / den
        c = (d00 * dot2 - d01 * dot1) / den
    hit = (t >= 0) & np.isfinite(t) & (b >= -1e-7) & (c >= -1e-7) & (b+c <= 1+1e-7)
    if not hit.any():
        failures.append({'kind': q['kind'], 'reason': 'no ray intersection'})
        continue
    nearest_t = np.where(hit, t, np.inf).min()
    depth = origin[2] + nearest_t * direction[2]
    residual = abs(depth - q['expectedDepth']) / extent
    max_residual = max(max_residual, float(residual))
    owner = q['expectedFace']
    owner_depth = origin[2] + t[owner] * direction[2]
    valid_owner = hit[owner] and abs(owner_depth - depth) <= extent * 1e-6
    if residual > 1e-6 or not valid_owner:
        failures.append({'kind': q['kind'], 'reason': 'depth or nearest owner mismatch', 'residual': float(residual)})
    by_kind[q['kind']] = by_kind.get(q['kind'], 0) + 1
print(json.dumps({'passed': not failures, 'queries': len(raw['queries']), 'byKind': by_kind,
                  'maxDepthResidualOverExtent': max_residual, 'failures': failures[:20]}))

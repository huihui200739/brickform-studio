"""Independent source-area conservation check in physical stud coordinates.
This checks that all source material area survives cell clipping; it does not
validate intrinsic colors, pose, kit appearance or procurement.
"""
import json
import sys
import numpy as np
raw = json.load(open(sys.argv[1], encoding='utf-8'))
p = np.asarray(raw['positions'], dtype=np.float64).reshape(-1, 3)
scale = raw['resolution'] / (p.max(axis=0) - p.min(axis=0)).max()
tri = (p * scale).reshape(-1, 3, 3)
area = np.linalg.norm(np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0]), axis=1) / 2
colors = np.asarray(raw['colors'], dtype=int)
by_color = np.bincount(colors, weights=area, minlength=len(raw['design']['materialAreaStudsSquared']))
design = raw['design']
source = float(area.sum())
residual = abs(source - design['sourceAreaStudsSquared']) / max(1., source)
captured = abs(source - design['capturedAreaStudsSquared']) / max(1., source)
material = float(np.abs(by_color - np.asarray(design['materialAreaStudsSquared'])).max()) / max(1., source)
print(json.dumps({'passed': max(residual, captured, material) < 1e-7,
 'sourceAreaStudsSquared': source, 'sourceAreaResidualFraction': residual,
 'capturedAreaResidualFraction': captured, 'materialAreaResidualFraction': material}))

"""Depth-sorted alpha compositing for actual offline catalog triangles.

Inputs must already be tested against the opaque depth buffer. Display alpha
approximates a translucent surface; it does not model refraction or absorption.
"""
import numpy as np


def _linear(rgb):
    value = rgb / 255
    return np.where(value <= .04045, value / 12.92,
                    ((value + .055) / 1.055) ** 2.4)


def _srgb(value):
    return np.where(value <= .0031308, value * 12.92,
                    1.055 * np.maximum(value, 0) ** (1 / 2.4) - .055) * 255


def composite_fragments(pixels, fragments):
    """Compose (flat pixel IDs, depth, RGB, alpha) from far to near per pixel.

    Larger depth is nearer. Do not write a transparent surface into the opaque
    depth buffer: opaque background remains visible through the front surface.
    """
    if not fragments:
        return
    ids = np.concatenate([fragment[0] for fragment in fragments])
    depths = np.concatenate([fragment[1] for fragment in fragments])
    colors = np.concatenate([
        np.broadcast_to(fragment[2], (len(fragment[0]), 3))
        for fragment in fragments
    ]).astype(float)
    alphas = np.concatenate([
        np.full(len(fragment[0]), fragment[3]) for fragment in fragments
    ])
    order = np.lexsort((depths, ids))
    ids, depths = ids[order], depths[order]
    colors, alphas = colors[order], alphas[order]
    # Triangles sharing an edge may rasterize the same surface fragment twice.
    # Keep coplanar duplicates from doubling the declared surface opacity.
    same = np.zeros(len(ids), dtype=bool)
    same[1:] = ((ids[1:] == ids[:-1])
                & (np.abs(depths[1:] - depths[:-1]) < 1e-8)
                & (np.abs(alphas[1:] - alphas[:-1]) < 1e-10)
                & np.all(colors[1:] == colors[:-1], axis=1))
    ids, colors, alphas = ids[~same], colors[~same], alphas[~same]
    starts = np.r_[True, ids[1:] != ids[:-1]]
    group_starts = np.maximum.accumulate(np.where(starts, np.arange(len(ids)), 0))
    layers = np.arange(len(ids)) - group_starts
    touched, local_ids = np.unique(ids, return_inverse=True)
    linear_pixels = _linear(pixels.reshape(-1, 3)[touched].astype(float))
    linear_colors = _linear(colors)
    for layer in range(int(layers.max()) + 1):
        selected = layers == layer
        target = local_ids[selected]
        alpha = alphas[selected, None]
        linear_pixels[target] = (linear_colors[selected] * alpha
                                 + linear_pixels[target] * (1 - alpha))
    # Only touched pixels are converted; opaque output retains exact bytes.
    pixels.reshape(-1, 3)[touched] = np.rint(
        np.clip(_srgb(linear_pixels), 0, 255)
    ).astype(np.uint8)

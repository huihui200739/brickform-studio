"""Behavior checks for translucent parts, including actual vendored flame CAD."""
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np
from PIL import Image

from render_transparency import composite_fragments


class TransparentCatalogRendering(unittest.TestCase):
    def test_depth_order_is_independent_of_fragment_submission(self):
        pixels = np.full((1, 2, 3), (220, 240, 250), dtype=np.uint8)
        front = (np.array([0, 1]), np.array([2., -2.]), (240, 143, 28), 128 / 255)
        rear = (np.array([0, 1]), np.array([-2., 2.]), (40, 80, 230), .5)
        forward, reverse = pixels.copy(), pixels.copy()
        composite_fragments(forward, [front, rear])
        composite_fragments(reverse, [rear, front])
        np.testing.assert_array_equal(forward, reverse)
        self.assertGreater(forward[0, 0, 0], forward[0, 1, 0])
        self.assertGreater(forward[0, 1, 2], forward[0, 0, 2])

    def test_half_display_alpha_preserves_background_light_and_shared_edges(self):
        pixels = np.full((1, 2, 3), 255, dtype=np.uint8)
        fragment = (np.array([0]), np.array([1.]), (0, 0, 0), 128 / 255)
        composite_fragments(pixels, [fragment, fragment])
        # One half-alpha black surface over white transmits 127/255 linear
        # light. Its sRGB encoding rounds to 187, not 127 or two-layer 137.
        np.testing.assert_array_equal(pixels[0, 0], (187, 187, 187))
        np.testing.assert_array_equal(pixels[0, 1], (255, 255, 255))

    def test_actual_flame_transmits_background_but_cannot_show_through_wall(self):
        identity = [1, 0, 0, 0, 1, 0, 0, 0, 1]
        flame_up = [1, 0, 0, 0, 0, -1, 0, 1, 0]
        wall = [
            {'part': '3001', 'color': 5,
             'pose': {'matrix': identity, 'position': [0, y, 0]}}
            for y in [-100, -76, -52, -28]
        ]
        variants = {
            'wall': wall,
            'front': wall + [{'part': '6126b', 'color': 14,
                             'pose': {'matrix': flame_up, 'position': [0, -12, 40]}}],
            'hidden': wall + [{'part': '6126b', 'color': 14,
                              'pose': {'matrix': flame_up, 'position': [0, -12, -40]}}],
        }
        with tempfile.TemporaryDirectory() as folder:
            images = {}
            for name, bricks in variants.items():
                model, image = Path(folder) / f'{name}.json', Path(folder) / f'{name}.png'
                model.write_text(json.dumps({'bricks': bricks}))
                subprocess.run([sys.executable, 'scripts/render-assembly.py',
                                str(model), str(image), 'front', '400'], check=True)
                images[name] = np.array(Image.open(image))
            # Entire wall image must match: no flame triangle or edge may
            # become visible through an opaque foreground catalog part.
            np.testing.assert_array_equal(images['wall'], images['hidden'])
            changed = np.any(images['front'] != images['wall'], axis=2)
            self.assertGreater(np.count_nonzero(changed), 100)
            self.assertLess(np.count_nonzero(changed), changed.size // 4)
            # A bright orange surface blends with the real green wall instead
            # of painting orange over it. The red channel rises while the
            # background green remains visible in the interior flame samples.
            painted = images['front'][changed]
            self.assertGreater(np.count_nonzero((painted[:, 0] > 100)
                                               & (painted[:, 1] > 90)), 50)


if __name__ == '__main__':
    unittest.main()

"""Diagnostic plots of fixed-source camera contour evidence, not product renders.

Uses only the saved canonical RGBA and candidate sample coordinates. Does not
edit model geometry, source images, albedo or production output files.
"""
import json
import math
from pathlib import Path

from PIL import Image, ImageDraw


root = Path('outputs/interior-camera-calibration')
manifest = []
for case in ('house', 'temple-standard'):
    data = json.loads((root / f'{case}.json').read_text())
    raw = (root / f'{case}.rgba').read_bytes()
    width, height = (int.from_bytes(raw[:4], 'little'), int.from_bytes(raw[4:8], 'little'))
    assert len(raw) == 8 + width * height * 4
    original = Image.frombytes('RGBA', (width, height), raw[8:])
    source = Image.new('RGBA', original.size, 'white')
    source.alpha_composite(original)
    tile_w, tile_h, pad, heading = 340, 382, 10, 46
    columns = 3
    candidates = data['candidates']
    chart = Image.new('RGB', (columns * tile_w, math.ceil(len(candidates) / columns) * tile_h + heading), '#f3f4f4')
    draw = ImageDraw.Draw(chart)
    draw.text((10, 8), f'{case}: fixed source geometry, interior contour experiment', fill='#172222')
    draw.text((10, 25), 'Blue = radiance edges; magenta = visible mesh creases. Unverified, no production change.', fill='#172222')
    scores = {item['id']: item for item in data['decision']['candidates']}
    for index, candidate in enumerate(candidates):
        x0 = (index % columns) * tile_w + pad
        y0 = (index // columns) * tile_h + heading
        draw.rectangle((x0 - 3, y0, x0 + 323, y0 + 370), fill='white')
        draw.text((x0, y0 + 4), f"{candidate['id']} yaw={candidate['camera']['yaw']} pitch={candidate['camera']['pitch']}", fill='#172222')
        score = scores[candidate['id']]
        draw.text((x0, y0 + 18), f"IoU {score['silhouetteIoU']:.3f} residual {score['match']['residual']:.3f} coverage {score['match']['coverage']:.3f}", fill='#172222')
        chart.paste(source.convert('RGB'), (x0, y0 + 34))
        # Plot observed sample coordinates rather than every source triangle edge.
        for sample in data['imageSamples']:
            x, y = x0 + sample['x'], y0 + 34 + sample['y']
            draw.line((x - sample['tx'], y - sample['ty'], x + sample['tx'], y + sample['ty']), fill='#00a9d7', width=1)
        for sample in candidate['samples']:
            x, y = x0 + sample['x'], y0 + 34 + sample['y']
            draw.line((x - sample['tx'], y - sample['ty'], x + sample['tx'], y + sample['ty']), fill='#e10091', width=1)
        label = 'original camera' if candidate['id'] == data['decision']['baselineId'] else 'camera candidate'
        if candidate['id'] == data['decision']['proposedId']:
            label += f" / {data['decision']['status']}"
        draw.text((x0, y0 + 358), label, fill='#172222')
    file = root / f'{case}-contours.png'
    chart.save(file)
    import hashlib
    manifest.append({'case': case, 'plot': str(file), 'sha256': hashlib.sha256(file.read_bytes()).hexdigest(),
                     'method': 'original-coordinate contour plot; no browser or CAD appearance acceptance'})
(root / 'plot-manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
print(json.dumps(manifest))

"""Grounded object identity + instance masks. Inference is strictly offline.

Input is a local image; output is observations, never bricks or world anchors.
Class scores and mask IoU estimates are different measurements, not calibrated
probabilities. Installation confidence is deliberately absent from this file.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import time

os.environ['HF_HUB_OFFLINE'] = '1'
os.environ['TRANSFORMERS_OFFLINE'] = '1'
os.environ['TOKENIZERS_PARALLELISM'] = 'false'

import numpy as np
from PIL import Image
import torch
from transformers import AutoProcessor, AutoModelForZeroShotObjectDetection, SamModel, SamProcessor

ROOT = Path(__file__).resolve().parents[1]
ENGINE = ROOT / 'work/semantic-engine'
# Include competing whole-object classes, not only the components we can build.
# A detection of a horse or locomotive must remain evidence of that identity.
PROMPTS = {
    'tree': 'tree', 'flame': 'brazier', 'torch': 'lamp', 'human statue': 'statue',
    'person': 'person', 'building': 'building', 'train': 'vehicle',
    'horse': 'animal', 'wizard hat': 'decor', 'sculpture head': 'decor',
}
THRESHOLD = 0.30


def overlap(a, b):
    intersection = max(0, min(a[2], b[2])-max(a[0], b[0])) * max(0, min(a[3], b[3])-max(a[1], b[1]))
    return intersection / max(1e-9, (a[2]-a[0])*(a[3]-a[1]) + (b[2]-b[0])*(b[3]-b[1])-intersection)


def contained(a, b):
    intersection = max(0, min(a[2], b[2])-max(a[0], b[0])) * max(0, min(a[3], b[3])-max(a[1], b[1]))
    return intersection / max(1e-9, min((a[2]-a[0])*(a[3]-a[1]), (b[2]-b[0])*(b[3]-b[1])))


def runs(mask):
    indices = np.flatnonzero(mask.ravel())
    if not len(indices):
        return []
    breaks = np.where(np.diff(indices) > 1)[0]
    starts = np.r_[indices[0], indices[breaks+1]]
    ends = np.r_[indices[breaks], indices[-1]]
    return np.stack([starts, ends-starts+1], axis=1).astype(int).ravel().tolist()


class LocalSceneAnalyzer:
    def __init__(self):
        torch.set_num_threads(min(4, os.cpu_count() or 1))
        torch.manual_seed(0)
        # CPU is a portable verified baseline; do not mix CUDA kernels with MPS.
        self.processor = AutoProcessor.from_pretrained(ENGINE / 'weights/detection', local_files_only=True, use_fast=False)
        self.detector = AutoModelForZeroShotObjectDetection.from_pretrained(ENGINE / 'weights/detection', local_files_only=True).eval()
        self.detector.config.disable_custom_kernels = True
        self.segmenter = SamModel.from_pretrained(ENGINE / 'weights/segmentation', local_files_only=True).eval()
        self.seg_processor = SamProcessor.from_pretrained(ENGINE / 'weights/segmentation', local_files_only=True)
        self.fingerprint = hashlib.sha256((ENGINE / 'ready.json').read_bytes() + Path(__file__).read_bytes()).hexdigest()

    @torch.inference_mode()
    def analyze(self, file):
        start = time.monotonic()
        if Path(file).suffix == '.rgba':
            import struct
            raw = Path(file).read_bytes()
            width, height = struct.unpack('<II', raw[:8])
            rgba = Image.frombytes('RGBA', (width, height), raw[8:])
        else:
            rgba = Image.open(file).convert('RGBA')
        rgba.thumbnail((1024, 1024), Image.Resampling.BILINEAR)
        width, height = rgba.size
        background = Image.new('RGBA', rgba.size, (255, 255, 255, 255))
        image = Image.alpha_composite(background, rgba).convert('RGB')
        prompt = '. '.join(PROMPTS) + '.'
        candidates = []
        # Overlapping tiles expose small instances to the same learned detector;
        # their coordinates and masks remain in the original reference frame.
        windows = [(0, 0, width, height)] + [(int(x*width), int(y*height), int((x+.6)*width), int((y+.6)*height))
                   for x in (0, .4) for y in (0, .4)]
        for left, top, right, bottom in windows:
            crop = image.crop((left, top, right, bottom))
            inputs = self.processor(images=crop, text=prompt, return_tensors='pt')
            output = self.detector(**inputs)
            grounded = self.processor.post_process_grounded_object_detection(
                output, inputs.input_ids, threshold=THRESHOLD, text_threshold=0.25,
                target_sizes=[(crop.height, crop.width)],
            )[0]
            for score, label, box in zip(grounded['scores'], grounded['text_labels'], grounded['boxes']):
                label = label.strip()
                matches = [name for name in PROMPTS if name == label or name in label]
                if set(matches) == {'human statue', 'person'}:
                    matches = ['human statue']
                if len(matches) != 1:
                    continue
                name = matches[0]
                box = box.clamp(min=0).tolist()
                box[2] = min(crop.width, box[2]); box[3] = min(crop.height, box[3])
                if box[2] <= box[0] or box[3] <= box[1]:
                    continue
                box = [box[0]+left, box[1]+top, box[2]+left, box[3]+top]
                candidates.append({'category': PROMPTS[name], 'label': name, 'score': float(score), 'box': box})
        candidates.sort(key=lambda c: -c['score'])
        selected = []
        for candidate in candidates:
            if any(candidate['category'] == prior['category'] and (overlap(candidate['box'], prior['box']) > 0.5 or
                   contained(candidate['box'], prior['box']) > 0.85) for prior in selected):
                continue
            selected.append(candidate)
            if len(selected) >= 24:
                break
        elements = []
        if selected:
            seg_inputs = self.seg_processor(image, input_boxes=[[c['box'] for c in selected]], return_tensors='pt')
            masks_out = self.segmenter(**seg_inputs, multimask_output=True)
            masks = self.seg_processor.image_processor.post_process_masks(
                masks_out.pred_masks, seg_inputs['original_sizes'], seg_inputs['reshaped_input_sizes'],
            )[0]
            for i, candidate in enumerate(selected):
                best = int(masks_out.iou_scores[0, i].argmax())
                mask = masks[i, best].numpy().astype(bool)
                mask &= np.array(rgba)[:, :, 3] > 100
                x0, y0, x1, y1 = candidate['box']
                # Keep masks within grounded bounds: segmentation may spill to a
                # whole facade despite a small flame/object detection.
                valid = np.zeros_like(mask)
                valid[int(y0):int(np.ceil(y1)), int(x0):int(np.ceil(x1))] = True
                mask &= valid
                ys, xs = np.where(mask)
                if len(xs) < 4:
                    continue
                bottom = int(np.quantile(ys, 0.98))
                bottom_x = xs[ys >= bottom]
                anchor = [float(np.median(bottom_x)) / max(1, width-1), bottom / max(1, height-1)]
                elements.append({
                    'category': candidate['category'], 'label': candidate['label'],
                    'identityScore': candidate['score'], 'identityThreshold': THRESHOLD,
                    'maskScore': float(masks_out.iou_scores[0, i, best]),
                    'imageBox': {'x': x0/width, 'y': y0/height, 'width': (x1-x0)/width, 'height': (y1-y0)/height},
                    'anchorUV': anchor, 'maskSize': [width, height], 'maskRuns': runs(mask),
                })
        # The catalog's statue is a humanoid, not any object that the language
        # model calls a sculpture. Require independently grounded person/body
        # evidence at the same location before replacing it with a figure.
        # Keep unresolved sculpture observations for downstream geometry.
        for element in elements:
            element['identitySupported'] = True
            if element['category'] == 'statue':
                a = element['imageBox']
                aa = [a['x'], a['y'], a['x']+a['width'], a['y']+a['height']]
                element['identitySupported'] = any(
                    other['category'] == 'person' and overlap(aa, [other['imageBox']['x'], other['imageBox']['y'],
                        other['imageBox']['x']+other['imageBox']['width'], other['imageBox']['y']+other['imageBox']['height']]) >= 0.5
                    for other in elements
                )
        return {
            'version': 1, 'imageSize': [width, height], 'engineFingerprint': self.fingerprint,
            'imageSha256': hashlib.sha256(Path(file).read_bytes()).hexdigest(),
            'models': json.loads((ENGINE / 'ready.json').read_text())['models'],
            'prompt': prompt, 'elements': elements, 'elapsedSeconds': round(time.monotonic()-start, 2),
        }


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('image', nargs='+')
    parser.add_argument('--output', required=True, help='Directory; one JSON per input stem')
    args = parser.parse_args()
    destination = Path(args.output)
    destination.mkdir(parents=True, exist_ok=True)
    analyzer = LocalSceneAnalyzer()
    for file in args.image:
        result = analyzer.analyze(file)
        (destination / (Path(file).stem + '.scene.json')).write_text(json.dumps(result, indent=2))
        print(json.dumps({'image': Path(file).name, 'seconds': result['elapsedSeconds'], 'objects': [(e['label'], round(e['identityScore'], 3)) for e in result['elements']]}), flush=True)

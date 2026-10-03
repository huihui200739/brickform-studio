"""Optional offline albedo hypothesis. Raw reference observations are immutable.

No model download is allowed. Pinned files are fully hashed before every
inference. The Float32 maps remain local; the response is aligned sRGB RGBA.
"""
import argparse
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import struct
import time

os.environ['HF_HUB_OFFLINE'] = '1'
os.environ['TRANSFORMERS_OFFLINE'] = '1'
os.environ['HF_HUB_DISABLE_TELEMETRY'] = '1'
os.environ['TOKENIZERS_PARALLELISM'] = 'false'

ROOT = Path(__file__).resolve().parents[1]
ENGINE = ROOT / 'work/intrinsic-engine'
MODEL = {'repo': 'prs-eth/marigold-iid-lighting-v1-1',
         'revision': '08c3930bb641abf786ba44ce92547507ebefbc16',
         'license': 'OpenRAIL++', 'codeLicense': 'Apache-2.0'}
CONFIG = {'device': 'mps', 'runtimeDtype': 'float32', 'steps': 4,
          'processingResolution': 512, 'ensembleSize': 1, 'seed': 735}
LIMITS = [
    'Single-image paint and illumination can be ambiguous; this is an inferred candidate, not material ground truth.',
    'The model can brighten real dark paint, shift hue and smooth fine texture. Equal-radiance controls with opposite paint explanations produce identical predictions.',
    'Observed reference pixels remain the source evidence. A finite or stable prediction does not validate paint preservation, geometry or physical buildability.',
]
EXPECTED_FILES = {
    "README.md": {
        "bytes": 6501,
        "gitBlob": "f9c88e631221a9a06509ff91b469c46ae9eb812b"
    },
    "gitattributes": {
        "bytes": 1590,
        "gitBlob": "9d16a792d0550807e597a7c3146fa2c41dcd1724"
    },
    "model_index.json": {
        "bytes": 857,
        "gitBlob": "2288e9e5cda1032fe86a31a98eda012c05256b88"
    },
    "scheduler/scheduler_config.json": {
        "bytes": 533,
        "gitBlob": "ece79362969e0d8a9ded0333156ba96a0f7c2269"
    },
    "text_encoder/config.json": {
        "bytes": 633,
        "gitBlob": "9c60528fdcb99a7caf834426a94ea13c56cf422b"
    },
    "text_encoder/model.fp16.safetensors": {
        "bytes": 680820392,
        "sha256": "bc1827c465450322616f06dea41596eac7d493f4e95904dcb51f0fc745c4e13f"
    },
    "tokenizer/merges.txt": {
        "bytes": 524619,
        "gitBlob": "76e821f1b6f0a9709293c3b6b51ed90980b3166b"
    },
    "tokenizer/special_tokens_map.json": {
        "bytes": 460,
        "gitBlob": "ae0c5be6f35217e51c4c000fd325d8de0294e99c"
    },
    "tokenizer/tokenizer_config.json": {
        "bytes": 855,
        "gitBlob": "bd2abe19377557ff5771584921f9b65fa041fef0"
    },
    "tokenizer/vocab.json": {
        "bytes": 1059962,
        "gitBlob": "469be27c5c010538f845f518c4f5e8574c78f7c8"
    },
    "unet/config.json": {
        "bytes": 1954,
        "gitBlob": "b89addfb3e7c45d8060d0c764457de7304d4f3a5"
    },
    "unet/diffusion_pytorch_model.fp16.safetensors": {
        "bytes": 1732019968,
        "sha256": "8c2e8da73793181f87c9c7a752a939d6f6834104e9854bf1c53c6b37de3594d9"
    },
    "vae/config.json": {
        "bytes": 711,
        "gitBlob": "87cb39197e3d376a794a6b9ae898e39d21de4773"
    },
    "vae/diffusion_pytorch_model.fp16.safetensors": {
        "bytes": 167335342,
        "sha256": "3e4c08995484ee61270175e9e7a072b66a6e4eeb5f0c266667fe1f45b90daf9a"
    }
}


def verify_weights():
    rows = []
    for filename, expected in EXPECTED_FILES.items():
        path = ENGINE / 'weights' / filename
        if not path.is_file() or path.stat().st_size != expected['bytes']:
            raise RuntimeError('Missing or incomplete pinned model file: ' + filename)
        digest = hashlib.sha256() if 'sha256' in expected else hashlib.sha1()
        if 'gitBlob' in expected:
            digest.update(b'blob ' + str(expected['bytes']).encode() + b'\0')
        with path.open('rb') as source:
            while block := source.read(1024 * 1024):
                digest.update(block)
        actual = digest.hexdigest()
        if actual != expected.get('sha256', expected.get('gitBlob')):
            raise RuntimeError('Pinned model hash mismatch: ' + filename)
        rows.append({'file': filename, **expected, 'verified': True})
    return rows


def ready_metadata():
    return {
        'version': 1, 'method': 'marigold-iid-lighting',
        'model': MODEL, 'config': CONFIG,
        'verifiedFiles': len(EXPECTED_FILES), 'files': EXPECTED_FILES,
        'runtimeVersions': {
            name: importlib.metadata.version(name)
            for name in ('torch', 'diffusers', 'transformers', 'numpy', 'Pillow')
        },
        'inferenceHypothesis': True,
    }


def load_runtime():
    import numpy as np
    from PIL import Image
    import torch
    from diffusers import MarigoldIntrinsicsPipeline
    if not torch.backends.mps.is_available():
        raise RuntimeError('The verified material runtime requires available MPS.')
    return np, Image, torch, MarigoldIntrinsicsPipeline


def atomic_json(path, data):
    temporary = path.with_suffix(path.suffix + '.tmp')
    temporary.write_text(json.dumps(data, separators=(',', ':'), allow_nan=False) + '\n')
    temporary.replace(path)


def analyze(file, destination):
    start = time.monotonic()
    # Validate before allocating an image or importing/starting the model.
    file = Path(file)
    if not file.is_file() or not 24 <= file.stat().st_size <= 8 + 320 * 320 * 4:
        raise ValueError('Invalid canonical raster size.')
    source = file.read_bytes()
    width, height = struct.unpack('<II', source[:8])
    if not (2 <= width <= 320 and 2 <= height <= 320 and
            len(source) == 8 + width * height * 4):
        raise ValueError('Invalid canonical raster dimensions/pixels.')
    source_sha = hashlib.sha256(source).hexdigest()
    verify_weights()
    np, Image, torch, pipeline_class = load_runtime()
    ready = ENGINE / 'ready.json'
    if not ready.exists() or json.loads(ready.read_text()) != ready_metadata():
        raise RuntimeError('Material runtime is not prepared for this pinned configuration.')
    ready_bytes = ready.read_bytes()
    fingerprint = hashlib.sha256(ready_bytes + Path(__file__).read_bytes()).hexdigest()
    rgba = np.frombuffer(source[8:], dtype=np.uint8).reshape(height, width, 4)
    image = Image.fromarray(rgba, 'RGBA')
    rgb = Image.new('RGB', (width, height), 'white')
    rgb.paste(image, mask=image.getchannel('A'))
    rgb_hash = hashlib.sha256(rgb.tobytes()).hexdigest()
    pipe = pipeline_class.from_pretrained(
        ENGINE / 'weights', variant='fp16', torch_dtype=torch.float32,
        local_files_only=True,
    ).to('mps')
    pipe.enable_attention_slicing()
    pipe.vae.enable_slicing()
    with torch.inference_mode():
        result = pipe(
            rgb, num_inference_steps=CONFIG['steps'],
            ensemble_size=CONFIG['ensembleSize'],
            processing_resolution=CONFIG['processingResolution'],
            match_input_resolution=True,
            generator=torch.Generator('cpu').manual_seed(CONFIG['seed']),
        )
    prediction = np.asarray(result.prediction, dtype=np.float32)
    if prediction.shape != (3, height, width, 3) or not np.isfinite(prediction).all():
        raise RuntimeError('Nonfinite or misaligned intrinsic maps; candidate rejected.')
    if prediction.min() < 0 or prediction.max() > 1:
        raise RuntimeError('Intrinsic maps are outside their declared linear range.')
    if pipe.target_properties['target_names'] != ['albedo', 'shading', 'residual']:
        raise RuntimeError('Unexpected intrinsic map target order.')
    if (hashlib.sha256(file.read_bytes()).hexdigest() != source_sha or
            hashlib.sha256(rgb.tobytes()).hexdigest() != rgb_hash):
        raise RuntimeError('Immutable source pixels changed during inference.')
    destination.mkdir(parents=True, exist_ok=True)
    stats = {}
    np.save(destination / 'prediction.npy', prediction)
    for index, name in enumerate(pipe.target_properties['target_names']):
        native = prediction[index]
        np.save(destination / (name + '.linear.npy'), native)
        stats[name] = {
            'shape': list(native.shape), 'dtype': str(native.dtype),
            'finiteFraction': 1.0, 'minimum': float(native.min()),
            'maximum': float(native.max()), 'mean': float(native.mean()),
            'std': float(native.std()),
        }
    # IEC sRGB encoding of native linear albedo, not image-editor brightening.
    albedo = prediction[0]
    encoded = np.where(albedo <= 0.0031308, 12.92 * albedo,
                       1.055 * np.power(albedo, 1 / 2.4) - 0.055)
    candidate_rgba = np.empty_like(rgba)
    candidate_rgba[:, :, :3] = np.rint(np.clip(encoded, 0, 1) * 255).astype(np.uint8)
    candidate_rgba[:, :, 3] = rgba[:, :, 3]
    if not np.array_equal(candidate_rgba[:, :, 3], rgba[:, :, 3]):
        raise RuntimeError('Original alpha was not preserved.')
    Image.fromarray(candidate_rgba, 'RGBA').save(destination / 'albedo.srgb.png')
    response = {'candidate': {
        'raster': {'width': width, 'height': height, 'data': candidate_rgba.ravel().tolist()},
        'provenance': {
            'method': 'marigold-iid-lighting',
            'modelRepo': MODEL['repo'], 'modelRevision': MODEL['revision'],
            'modelLicense': MODEL['license'], 'sourceSha256': source_sha,
            'engineFingerprint': fingerprint, **CONFIG,
            'inferenceHypothesis': True, 'originalAlphaPreserved': True,
            'elapsedSeconds': round(time.monotonic() - start, 3),
            'limits': LIMITS, 'mapStats': stats,
        },
    }}
    atomic_json(destination / 'material-analysis.json', response)
    print(json.dumps({'sourceSha256': source_sha, 'engineFingerprint': fingerprint,
                      'imageSize': [width, height], 'finite': True,
                      'seconds': response['candidate']['provenance']['elapsedSeconds']}), flush=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('image', nargs='?')
    parser.add_argument('--output', type=Path)
    parser.add_argument('--prepare', action='store_true',
                        help='Verify installed files/runtime and write fixed ready metadata; never downloads.')
    args = parser.parse_args()
    if args.prepare:
        if args.image or args.output:
            raise ValueError('--prepare cannot be combined with an inference request.')
        verify_weights()
        load_runtime()
        ENGINE.mkdir(parents=True, exist_ok=True)
        atomic_json(ENGINE / 'ready.json', ready_metadata())
        print(json.dumps({'configured': True, 'verifiedFiles': len(EXPECTED_FILES),
                          'model': MODEL, 'config': CONFIG}), flush=True)
        return
    if not args.image or not args.output:
        parser.error('image and --output are required for inference.')
    # Also serialize across separate local server instances/processes.
    import fcntl
    ENGINE.mkdir(parents=True, exist_ok=True)
    with (ENGINE / 'material-inference.lock').open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuntimeError('Another local material inference is running.')
        analyze(args.image, args.output)


if __name__ == '__main__':
    main()

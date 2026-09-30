"""Fetch only pinned safetensors/configs; record hashes for cache provenance."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import importlib.metadata

root = Path(__file__).resolve().parents[1]
engine = root / 'work/semantic-engine'
manifest = json.loads((root / 'scripts/semantic-models.json').read_text())
files = {
    'detection': ['config.json', 'preprocessor_config.json', 'tokenizer.json',
                  'tokenizer_config.json', 'special_tokens_map.json', 'added_tokens.json',
                  'vocab.txt', 'model.safetensors'],
    'segmentation': ['config.json', 'preprocessor_config.json', 'model.safetensors'],
}
hashes = {}
for kind, source in manifest.items():
    target = engine / 'weights' / kind
    target.mkdir(parents=True, exist_ok=True)
    for filename in files[kind]:
        file = target / filename
        if not file.exists():
            temporary = target / (filename + '.download')
            command = ['curl', '--fail', '--location', '--show-error', '--continue-at', '-',
                       '--connect-timeout', '30', '--max-time', '900']
            if os.environ.get('BRICKFORM_SEMANTIC_PROXY'):
                command += ['--proxy', os.environ['BRICKFORM_SEMANTIC_PROXY']]
            command += [f"https://huggingface.co/{source['repo']}/resolve/{source['revision']}/{filename}",
                        '-o', str(temporary)]
            # Resume a bounded number of interrupted transfers; never replace
            # an incomplete file or quietly accept it as a valid checkpoint.
            for attempt in range(6):
                result = subprocess.run(command)
                if result.returncode == 0:
                    break
                if result.returncode not in (18, 28, 56) or attempt == 5:
                    result.check_returncode()
            temporary.replace(file)
        if filename.endswith('.json'):
            json.loads(file.read_text())
        hashes[f'{kind}/{filename}'] = hashlib.sha256(file.read_bytes()).hexdigest()
    # Verify model format and configuration before advertising readiness.
    from safetensors import safe_open
    with safe_open(target / 'model.safetensors', framework='pt', device='cpu') as model:
        if not list(model.keys()):
            raise RuntimeError('Empty checkpoint')
ready = { 'models': manifest, 'files': hashes,
          'runtime': {name: importlib.metadata.version(name) for name in ['torch', 'torchvision', 'transformers', 'numpy', 'pillow']} }
(engine / 'ready.json').write_text(json.dumps(ready, indent=2))
print('Local identity + segmentation weights verified.')

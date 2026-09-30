"""Download pinned public test inputs; never download weights or invoke inference."""
import base64
import hashlib
import json
import os
from pathlib import Path
import sys
import urllib.request

root = Path(__file__).resolve().parents[1]
manifest = json.loads((root / 'benchmarks/image-cases.json').read_text())
destination = Path(sys.argv[1]) if len(sys.argv) > 1 else root / 'outputs/image-benchmark/inputs'
destination.mkdir(parents=True, exist_ok=True)
proxy = os.environ.get('BRICKFORM_BENCH_PROXY')
opener = urllib.request.build_opener(urllib.request.ProxyHandler(
    {'https': proxy} if proxy else {},
))
for case in manifest['cases']:
    target = destination / case['image']
    if target.exists() and hashlib.sha256(target.read_bytes()).hexdigest() == case['sha256']:
        print(f"Verified cache: {case['id']}")
        continue
    url = ('https://api.github.com/repos/Tencent/Hunyuan3D-2/contents/'
           f"{manifest['sourceDirectory']}/{case['image']}?ref={manifest['sourceRevision']}")
    request = urllib.request.Request(url, headers={'User-Agent': 'Brickform-image-benchmark'})
    with opener.open(request, timeout=30) as response:
        data = json.loads(response.read(2 * 1024 * 1024))
    content = base64.b64decode(''.join(data['content'].split()), validate=True)
    if hashlib.sha256(content).hexdigest() != case['sha256']:
        raise RuntimeError(f"Checksum mismatch: {case['id']}; cache left unchanged")
    target.write_bytes(content)
    print(f"Downloaded and verified: {case['id']}")

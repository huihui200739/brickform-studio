#!/bin/sh
# Isolated Apple Silicon inference dependencies and verified public checkpoint.
set -eu
cd "$(dirname "$0")/.."
ENGINE=work/multiview-engine
REVISION=d2cc98ef7fb2166dc7e3b826b487e80f6f5027dc
if ! command -v uv >/dev/null 2>&1; then
  python3 -m venv work/multiview-bootstrap
  work/multiview-bootstrap/bin/pip install uv==0.12.21
  UV=work/multiview-bootstrap/bin/uv
else
  UV=uv
fi
if [ ! -d "$ENGINE/.git" ]; then
  git clone https://github.com/appautomaton/mlx-spatial.git "$ENGINE"
fi
if [ "$(git -C "$ENGINE" rev-parse HEAD)" != "$REVISION" ]; then
  git -C "$ENGINE" checkout --detach "$REVISION"
fi
if [ ! -x "$ENGINE/.venv/bin/python" ]; then
  "$UV" venv --python 3.13 "$ENGINE/.venv"
fi
"$UV" pip install --python "$ENGINE/.venv/bin/python" mlx==0.32.3 numpy==2.5.3 pillow==12.3.0 pyyaml==6.0.3 scipy==1.18.1 fast-simplification==0.2.0 trimesh==5.1.0 scikit-image==0.26.0 huggingface-hub
"$ENGINE/.venv/bin/hf" download facebook/map-anything config.json model.safetensors --local-dir "$ENGINE/weights/map-anything"
"$ENGINE/.venv/bin/python" scripts/verify-local-multiview.py

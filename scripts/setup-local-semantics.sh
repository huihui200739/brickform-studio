#!/bin/sh
# Isolated, versioned local object detection. Downloads weights, never images.
set -eu
cd "$(dirname "$0")/.."
ENGINE=work/semantic-engine
UV=${BRICKFORM_UV:-work/multiview-bootstrap/bin/uv}
if command -v uv >/dev/null 2>&1; then UV=uv; fi
if [ ! -x "$UV" ] && [ "$UV" != uv ]; then
  python3 -m venv work/semantic-bootstrap
  work/semantic-bootstrap/bin/pip install uv==0.12.21
  UV=work/semantic-bootstrap/bin/uv
fi
if [ ! -x "$ENGINE/.venv/bin/python" ]; then
  "$UV" venv --python 3.13 "$ENGINE/.venv"
fi
"$UV" pip install --python "$ENGINE/.venv/bin/python" torch==2.8.0 torchvision==0.23.0 transformers==4.57.1 pillow==12.3.0 scipy==1.18.1
"$ENGINE/.venv/bin/python" scripts/fetch-semantic-models.py

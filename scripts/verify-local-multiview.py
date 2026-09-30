from pathlib import Path
import hashlib, json, sys
ROOT=Path(__file__).resolve().parents[1]
ENGINE=ROOT/'work/multiview-engine'
sys.path.insert(0,str(ENGINE/'src'))
model=ENGINE/'weights/map-anything/model.safetensors'
EXPECTED='981f060c64664dff3272b5f5a823d350abe71a2f144444db4cfc325f3ed5a3a0'
assert model.stat().st_size==4914062480, 'Incomplete checkpoint'
with model.open('rb') as f: assert hashlib.file_digest(f,'sha256').hexdigest()==EXPECTED, 'Checkpoint checksum mismatch'
from mlx_spatial.mapanything_assets import validate_mapanything_assets
result=validate_mapanything_assets(model.parent)
assert result.ready, str(result)
(ENGINE/'ready.json').write_text(json.dumps({'sha256':EXPECTED,'engine':'MapAnything MLX','jointViews':3}))
print('Local multi-view runtime and weights verified')

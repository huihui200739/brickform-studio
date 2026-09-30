#!/usr/bin/env python3
"""Local joint three-image reconstruction followed by camera-aware depth fusion."""
from pathlib import Path
import argparse, importlib.util, sys

ROOT = Path(__file__).resolve().parents[1]
ENGINE = ROOT / 'work/multiview-engine'
sys.path.insert(0, str(ENGINE / 'src'))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('images', type=Path)
    parser.add_argument('output', type=Path)
    args = parser.parse_args()
    from mlx_spatial.mapanything_scene import MapAnythingScenePipeline, write_mapanything_scene_npz
    import mlx.core as mx
    mx.set_cache_limit(256 * 1024 * 1024)
    print('[5%] Joint camera and depth inference for all three images', flush=True)
    result = MapAnythingScenePipeline(ENGINE / 'weights/map-anything').generate(args.images)
    if not result.ready or result.predictions is None:
        raise RuntimeError(str(result.trace.blocker))
    write_mapanything_scene_npz(args.output.with_suffix('.npz'), result.predictions)
    print('[75%] Fusing depths in one shared world frame', flush=True)
    spec = importlib.util.spec_from_file_location('fusion', ROOT / 'scripts/multiview-fusion.py')
    fusion = importlib.util.module_from_spec(spec); spec.loader.exec_module(fusion)
    report = fusion.fuse_scene(result.predictions.as_npz_payload(), args.output)
    for failure in report['failures']: print(f'Calibration warning: {failure}', flush=True)
    print('[100%] Three-view mesh ready', flush=True)


if __name__ == '__main__': main()

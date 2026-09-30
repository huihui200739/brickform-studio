# Cross-category single-image benchmark

This exercises real local inference and the same conversion functions as the
image worker. It does not substitute known meshes for image reconstruction.
The six pinned public example inputs and their manually checked negative
semantic labels are in `image-cases.json`. They are clean renders/illustrations,
not a held-out photograph dataset or official LEGO model ground truth.

## Run

Requires the already documented local Hunyuan3D installation, the local identity
runtime (`sh scripts/setup-local-semantics.sh`), Node and Python
with Pillow. The downloader only obtains the six pinned images. Inference uses
the existing local weights; it does not call a paid API.

```sh
python3 scripts/fetch-benchmark-images.py
npm run benchmark:images -- --native
```

Each case stores its prepared reference, GLB, inference settings/log and brick
model under `outputs/image-benchmark/`. Settings are the production 30 steps,
octree 128 and input-hash seed. Matching cached inference settings/input hashes
allow conversion-only replay:

```sh
npm run benchmark:images
npm run benchmark:images -- --case=house
npm run benchmark:images -- --resolution=48
python3 scripts/render-assembly.py outputs/image-benchmark/house/bricks-28.json outputs/image-benchmark/house/assembly.png hero 600
```

`BRICKFORM_BENCH_PYTHON` selects the Python executable used for resizing;
`BRICKFORM_BENCH_PROXY` optionally selects an HTTPS proxy for the downloader.
Image decoding/resizing is offline Pillow bilinear, approximating the browser's
320-pixel reference downsample, not an exact browser replay. Only one native
inference runs at a time. Missing inputs, invalid hashes and conversion failures
are recorded as failures; no synthetic replacement is used.

## Read the results

- `status: converted` means a model was produced, not that product quality passed.
- `validation` contains the existing collision/catalog/connection checks.
- `semanticGatePassed` rejects actually committed component kinds manually
  annotated as absent from that input. These labels do not score all visual errors.
- `partTypes` counts distinct part IDs; `partColorTypes` counts BOM combinations.
- Exit code 1 means conversion failed or the negative semantic gate failed.
- Six full results use `results-28.json`; a selected case has a separate filename
  so it cannot overwrite the full batch evidence.

The September 30 baseline contains six successful conversions and six semantic
quality failures. This is an intentionally failing product benchmark, while the
159 existing unit tests pass. The new CLI's failure path was verified with a
cached house replay: no native inference, one false brazier, exit code 1.

The baseline records actual generated mesh hashes. A different native runtime
or weight version can change its output; compare fingerprints before interpreting
differences. Outputs are local caches, not clean-clone unit fixtures. Do not
describe this benchmark as a physical build or an official LEGO quality rating.

The October 1 implementation uses real Grounding DINO + SlimSAM observations,
with input/weight/runner fingerprints and a separate conversion fingerprint.
`image-semantic-2026-10-01.json` records zero forbidden installations on all six
inputs; the old September 30 baseline remains a historical failure record.
Unknown/unsupported identities retain source geometry, including ambiguous
sculptures that must not become a humanoid catalog figure. Positive temple
fixtures also require the statue and both attached braziers, so disabling all
automatic components cannot satisfy those checks.

Cached learned observations can be replayed with `--scene-dir=<directory>`;
the runner checks their input and engine hashes instead of trusting a filename.

## 结构化壁龛回归（2026-10-01）

`node --experimental-strip-types scripts/benchmark-geometry.ts` 使用两份实际神庙失败草稿与记录的真实视觉结果，重放 28/36/48 六次转换。`geometry-2026-10-01.json` 记录后墙平面、材料推断、空腔、最终零件检查和来源哈希；`image-geometry-2026-10-01.json` 保存同期六类图转换。此批转换指纹覆盖全部生产库和 JS 锁文件，旧记录仍保留当时的指纹范围。

六个入口后墙检查通过，不能作为整栋建筑/任意图片外观、承重、插入路径或实物步骤的验收。`outputs/geometry-calibration/` 的目录件离线图用于本机形状检查，不是浏览器或实物证据。

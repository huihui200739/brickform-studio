# Portable image and geometry regressions

The temple fixtures are derived from the user's reference images and locally
generated geometry, not known ideal CAD models. They replay actual production
failures. Scene JSON contains real Grounding DINO tiny + SlimSAM observations;
model revisions, raw scores, masks and fingerprints remain in each record.

- `temple-standard.glb.gz` / `.rgba.gz`: September 30 native draft and exact
  320×320 reference used by `current-temple.test.ts`.
- `temple-standard.scene.json`: October 1 learned observations for that raster.
- `temple-original.mesh.json.gz`, `.raster.json.gz`, `.model.json.gz`: original
  mesh, 256×320 reference and brick model previously read from ignored outputs
  by surface calibration regressions. Geometry is restored to typed arrays.
- `temple-original.regions.json`: explicit original statue region for the
  direct/manual unsupported-surface preservation regression.
- `temple-original.scene.json`: learned observations for the original raster.

Normal unit tests use recorded observations and require neither downloads nor
local ML weights. Native inference is exercised separately by the image
benchmark. Passing a recorded-output regression does not establish recognition
quality on unseen photos, shape fidelity or load stability.

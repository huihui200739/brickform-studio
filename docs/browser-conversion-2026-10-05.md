# Browser conversion verification — 2026-10-05

## Available website

The local website at `http://localhost:3000/` is running with `npm run local`.
An HTTP check returned 200, and the in-app browser shows the completed high-detail conversion.

## High-detail conversion fix

The assembly planner's recursive articulation-point traversal exceeded the browser worker's call-stack limit on the Temple GLB at 48-stud resolution. `lib/connection-plan.ts` now uses explicit DFS frames, preserving neighbor order and articulation rules. The regression uses an 800-part connected chain in a subprocess with a 128 KB stack and checks every planned part's order, insertion direction, and parent.

The actual browser conversion succeeded with 8,101 parts, 16 part types, and 976 steps. The UI reports that connection and overlap checks passed. This verifies GLB conversion and instruction generation, not reference-image fidelity or physical stability.

Input: the decompressed `lib/fixtures/temple-standard.glb.gz`, imported as a GLB without a reference image or semantic detections. SHA-256: `432bff9f81a91d9e02f9e8ba3b09344b107fe2a6d08a1266ddce172215ed051f`. The displayed white material and sample-duck sidebar are not a new photo-generation result. Screenshot: `outputs/web-conversion-calibration/high-detail-browser.jpg` (local verification artifact).

Completed checks: 269 production tests; 100 regional-design tests; typecheck; build including packaged image-worker verification; scoped lint; diff whitespace check.

## Regional reconstruction remains experimental

New source-region selection and exterior-layout modules remain under `scripts/regional-design/`; the web generation pipeline does not call them. Complete source enumeration found 155 geometry-eligible Temple regions and 107 House regions. These counts do not establish successful region reconstruction. A complete automatic layout replay has not been performed.

The experimental exterior solver now retains every positive-area foreground contribution, checks complete projection coverage rather than an area tolerance, charges empty spatial-index lookups against the work budget, and handles grid-boundary arithmetic conservatively. Source face/depth provenance and unchanged body colors remain mandatory. Candidate layouts undergo a full-model connection and declared-geometry audit.

The three explicit Temple compound controls A, B, and C produced no accepted changes after the numerical repairs. The statue's surrounding irregular frame is therefore still unresolved. Reconstructing those compound sections needs an appropriate profile target; exterior empty-cell removal alone has not fixed it.

`scripts/benchmark-exterior-regions.ts` accepts `--baseline-evidence=...` and rejects stale conversion fingerprints. Its full automatic replay has not yet run. The October 4 frozen evidence remains historical, and must not be presented as evidence for the planner revision. Unverified section-construction work is preserved in ignored `work/regional-design/source-sections.ts.pending`; it is not included in the compiled or committed implementation.

Next work: regenerate matched baseline evidence for the current conversion revision, run the bounded automatic layout replay, then develop and verify compound-section targets. No claim of arbitrary-image official-set quality, complete insertion-path validation, stock availability, or physical buildability is made.

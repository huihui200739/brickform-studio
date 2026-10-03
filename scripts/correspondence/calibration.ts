import type { ReferenceCamera } from '../../lib/reference-colors.ts';
import type { ContourSample } from './mesh-contours.ts';
import { scoreContourCorrespondence } from './image-contours.ts';

export type ContourCameraCandidate = {
  id: string;
  camera: ReferenceCamera;
  silhouetteIoU: number;
  samples: ContourSample[];
};

function supportForRanking(
  samples: ContourSample[],
  match: ReturnType<typeof scoreContourCorrespondence>,
  imageSize: [number, number],
) {
  const supportReasons: string[] = [];
  if (!Number.isFinite(match.residual))
    supportReasons.push('no-finite-candidate');
  if (match.residual > 0.35)
    supportReasons.push('persistent-interior-residual');
  if (match.coverage < 0.6)
    supportReasons.push('insufficient-directional-coverage');
  const matchedGroups = match.groups.filter((group) => group.coverage >= 0.6);
  const imageGroups = new Set(
    matchedGroups.flatMap((group) => group.matchedImageComponents),
  );
  if (matchedGroups.length < 3 || imageGroups.size < 3)
    supportReasons.push('insufficient-independent-contours');
  const supportedGroupIds = new Set(matchedGroups.map((group) => group.group));
  let xx = 0,
    xy = 0,
    yy = 0,
    weight = 0;
  let minX = Infinity,
    maxX = -Infinity,
    minY = Infinity,
    maxY = -Infinity;
  for (const sample of samples) {
    if (
      !supportedGroupIds.has(sample.group) ||
      ![sample.x, sample.y, sample.tx, sample.ty, sample.weight].every(
        Number.isFinite,
      )
    )
      continue;
    const length = Math.hypot(sample.tx, sample.ty);
    if (!length || sample.weight <= 0) continue;
    const tx = sample.tx / length,
      ty = sample.ty / length;
    xx += sample.weight * tx * tx;
    xy += sample.weight * tx * ty;
    yy += sample.weight * ty * ty;
    weight += sample.weight;
    minX = Math.min(minX, sample.x);
    maxX = Math.max(maxX, sample.x);
    minY = Math.min(minY, sample.y);
    maxY = Math.max(maxY, sample.y);
  }
  const directionDeterminant = weight
    ? (xx * yy - xy * xy) / (weight * weight)
    : 0;
  if (directionDeterminant < 0.035)
    supportReasons.push('parallel-or-degenerate-contours');
  if (maxX - minX < imageSize[0] * 0.2 || maxY - minY < imageSize[1] * 0.2)
    supportReasons.push('spatially-concentrated-contours');
  return {
    supportReasons,
    supportedForRanking: supportReasons.length === 0,
    matchedGroups,
    independentImageContours: imageGroups.size,
    directionDeterminant,
  };
}

/** Experimental evidence gate. Image gradients are not independent geometry
 * labels, so even a supported candidate never authorizes a production rewrite.
 * Keep the original image/camera/ledger and inspect the displayed matches. */
export function evaluateContourCameras(
  candidates: ContourCameraCandidate[],
  imageSamples: ContourSample[],
  baselineId: string,
  imageSize: [number, number],
) {
  const scored = candidates.map((candidate) => {
    const match = scoreContourCorrespondence(candidate.samples, imageSamples);
    return {
      ...candidate,
      match,
      ...supportForRanking(candidate.samples, match, imageSize),
    };
  });
  const baseline = scored.find((candidate) => candidate.id === baselineId);
  if (!baseline) throw Error('Missing baseline camera.');
  const eligible = scored
    .filter(
      (candidate) => candidate.silhouetteIoU >= baseline.silhouetteIoU - 0.01,
    )
    .sort(
      (a, b) => a.match.residual - b.match.residual || a.id.localeCompare(b.id),
    );
  // A camera showing only one easy line can have a smaller directed average
  // than the correct camera showing many features. Reject sparse/degenerate
  // support BEFORE ranking, not after that camera suppresses valid candidates.
  const supportedCandidates = eligible.filter(
    (candidate) => candidate.supportedForRanking,
  );
  const ranked = supportedCandidates.length ? supportedCandidates : eligible;
  const best = ranked[0];
  if (!best) throw Error('No eligible camera.');
  const reasons = best.supportReasons.slice();
  // Many triangle edges against one closed image contour do not create many
  // independent landmarks. Require distinct observed chains as well as groups.
  const matchedGroups = best.matchedGroups;
  const runnerUp = supportedCandidates.find(
    (candidate) => candidate.id !== best.id,
  );
  const candidateGap = runnerUp
    ? runnerUp.match.residual - best.match.residual
    : 0;
  if (!runnerUp || candidateGap < 0.025)
    reasons.push('competing-camera-ambiguity');
  // Leave out each of the largest *image-supported* geometric groups. These
  // are matching stability controls, not probability/parameter-rank estimates.
  const leaveOneOut = matchedGroups
    .slice()
    .sort((a, b) => b.matchedWeight - a.matchedWeight)
    .slice(0, 12)
    .map((group) => {
      const alternatives = ranked
        .map((candidate) => ({
          id: candidate.id,
          residual: scoreContourCorrespondence(
            candidate.samples,
            imageSamples,
            group.group,
          ).residual,
        }))
        .sort((a, b) => a.residual - b.residual || a.id.localeCompare(b.id));
      return {
        omittedGroup: group.group,
        winner: alternatives[0].id,
        stable: alternatives[0].id === best.id,
      };
    });
  if (!leaveOneOut.length || leaveOneOut.some((control) => !control.stable))
    reasons.push('single-contour-sensitive');
  const correction = best.id !== baseline.id;
  if (correction && !baseline.supportedForRanking)
    reasons.push('baseline-has-no-comparable-interior-evidence');
  else if (correction && baseline.match.residual - best.match.residual < 0.05)
    reasons.push('insufficient-contour-improvement');
  return {
    version: 1,
    status: reasons.length ? 'unresolved' : 'supported-experimental-candidate',
    proposedCamera: { ...best.camera },
    proposedId: best.id,
    baselineId,
    correction,
    productionCameraChanged: false,
    interiorCorrespondenceVerified: false,
    materialIdentityVerified: false,
    reasons,
    directionDeterminant: best.directionDeterminant,
    independentImageContours: best.independentImageContours,
    candidateGap,
    leaveOneOut,
    candidates: scored.map(
      ({
        id,
        camera,
        silhouetteIoU,
        samples,
        match,
        supportedForRanking,
        supportReasons,
      }) => ({
        id,
        camera,
        silhouetteIoU,
        geometrySamples: samples.length,
        supportedForRanking,
        supportReasons,
        match,
      }),
    ),
    limitations:
      'Persistent image edges may be paint, mortar, shadow or geometry. Nearby pose search is bounded and cannot recover missing source geometry. Matching stability does not establish camera truth or hidden material identity. No automatic production changes.',
  };
}

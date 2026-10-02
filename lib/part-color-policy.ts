import { PALETTE } from './brick-engine.ts';
import { colors } from './material-color-space.ts';
import {
  partColorEvidence,
  type PurchaseSource,
} from './purchase-inventory.ts';

export type PartColorSubstitution = {
  requestedColor: number;
  selectedColor: number;
  reason: 'reviewed-unsupported-catalog-color';
  source: PurchaseSource;
};

/** Resolve explicit negative evidence before emitting a catalog component.
 * Unknown combinations are retained for review. Never deletes geometry. */
export function choosePartColor(
  part: string,
  requestedColor: number,
): {
  color: number;
  substitution?: PartColorSubstitution;
} {
  const palette = Number.isInteger(requestedColor)
    ? PALETTE[requestedColor]
    : undefined;
  const evidence = partColorEvidence(part);
  if (!palette || !evidence?.unsupportedLegoColors.includes(palette.lego))
    return { color: requestedColor };
  const target = colors[requestedColor];
  const distance = (index: number) => {
    const c = colors[index];
    return (
      0.5 * (c[0] - target[0]) ** 2 +
      (c[1] - target[1]) ** 2 +
      (c[2] - target[2]) ** 2
    );
  };
  const selectedColor = [...evidence.confirmedPaletteColors].sort(
    (a, b) => distance(a) - distance(b) || a - b,
  )[0];
  if (selectedColor === undefined) return { color: requestedColor };
  return {
    color: selectedColor,
    substitution: {
      requestedColor,
      selectedColor,
      reason: 'reviewed-unsupported-catalog-color',
      source: evidence.source,
    },
  };
}

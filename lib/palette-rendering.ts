/** LDraw display alpha is a preview approximation, not an optical material model. */
export function paletteMaterial(color: { hex: string; opacity?: number }) {
  if (color.opacity === undefined || color.opacity >= 1)
    return { color: color.hex };
  return {
    color: color.hex,
    transparent: true,
    opacity: color.opacity,
    // Opaque geometry still occludes these parts; translucent surfaces must
    // blend with geometry behind them instead of replacing its depth.
    depthWrite: false,
  };
}

/** Candidate overlays fade the palette material instead of replacing its alpha. */
export function paletteOverlayMaterial(
  color: { hex: string; opacity?: number },
  confirmed: boolean,
) {
  const material = paletteMaterial(color);
  if (confirmed) return material;
  return {
    ...material,
    transparent: true,
    opacity: (color.opacity ?? 1) * 0.35,
    depthWrite: false,
  };
}

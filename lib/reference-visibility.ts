/** Depth-tested projection of source triangles. Bins accelerate exact queries
 * for faces smaller than a raster pixel; no model-scale occlusion allowance. */
export function referenceVisibility(
  coords: Float64Array,
  extent: number,
  perspective: number,
  size: number,
) {
  const faces = coords.length / 9;
  const denominator = new Float64Array(faces);
  const binsPerSide = 32;
  const bins: number[][] = Array.from(
    { length: binsPerSide * binsPerSide },
    () => [],
  );
  const bin = (value: number) =>
    Math.max(
      0,
      Math.min(binsPerSide - 1, Math.floor((value / size) * binsPerSide)),
    );
  for (let t = 0; t < faces; t++) {
    const i = t * 9;
    const ax = coords[i],
      ay = coords[i + 1];
    const bx = coords[i + 3],
      by = coords[i + 4];
    const cx = coords[i + 6],
      cy = coords[i + 7];
    const den = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
    if (Math.abs(den) < 1e-10) continue;
    denominator[t] = den;
    for (let y = bin(Math.min(ay, by, cy)); y <= bin(Math.max(ay, by, cy)); y++)
      for (
        let x = bin(Math.min(ax, bx, cx));
        x <= bin(Math.max(ax, bx, cx));
        x++
      )
        bins[y * binsPerSide + x].push(t);
  }
  const depthAt = (t: number, x: number, y: number) => {
    const i = t * 9,
      den = denominator[t];
    if (!den) return -Infinity;
    const ax = coords[i],
      ay = coords[i + 1];
    const bx = coords[i + 3],
      by = coords[i + 4];
    const cx = coords[i + 6],
      cy = coords[i + 7];
    const a = ((by - cy) * (x - cx) + (cx - bx) * (y - cy)) / den;
    const b = ((cy - ay) * (x - cx) + (ax - cx) * (y - cy)) / den;
    const c = 1 - a - b;
    if (a < -1e-9 || b < -1e-9 || c < -1e-9) return -Infinity;
    const za = coords[i + 2],
      zb = coords[i + 5],
      zc = coords[i + 8];
    // Screen barycentrics are not world barycentrics in a perspective view.
    const wa = 1 - (perspective * za) / extent;
    const wb = 1 - (perspective * zb) / extent;
    const wc = 1 - (perspective * zc) / extent;
    return (
      ((a * za) / wa + (b * zb) / wb + (c * zc) / wc) /
      (a / wa + b / wb + c / wc)
    );
  };
  const frontAt = (x: number, y: number) => {
    let depth = -Infinity,
      face = -1;
    for (const t of bins[bin(y) * binsPerSide + bin(x)]) {
      const z = depthAt(t, x, y);
      if (z > depth) {
        depth = z;
        face = t;
      }
    }
    return { face, depth };
  };
  const depth = new Float64Array(size * size).fill(-Infinity);
  const pixelFace = new Int32Array(size * size).fill(-1);
  for (let t = 0; t < faces; t++) {
    if (!denominator[t]) continue;
    const i = t * 9;
    const x0 = Math.max(
      0,
      Math.floor(Math.min(coords[i], coords[i + 3], coords[i + 6])),
    );
    const x1 = Math.min(
      size - 1,
      Math.ceil(Math.max(coords[i], coords[i + 3], coords[i + 6])),
    );
    const y0 = Math.max(
      0,
      Math.floor(Math.min(coords[i + 1], coords[i + 4], coords[i + 7])),
    );
    const y1 = Math.min(
      size - 1,
      Math.ceil(Math.max(coords[i + 1], coords[i + 4], coords[i + 7])),
    );
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) {
        const z = depthAt(t, x + 0.5, y + 0.5),
          k = y * size + x;
        if (z > depth[k]) {
          depth[k] = z;
          pixelFace[k] = t;
        }
      }
  }
  return { pixelFace, frontAt, depthAt, tolerance: extent * 1e-7 };
}

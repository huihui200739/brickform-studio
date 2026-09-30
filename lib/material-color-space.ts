import { PALETTE } from './brick-engine.ts';

export function lab(r: number, g: number, b: number) {
  const f = (v: number) => {
    v /= 255;
    return v > 0.04045 ? ((v + 0.055) / 1.055) ** 2.4 : v / 12.92;
  };
  const x = f(r),
    y = f(g),
    z = f(b);
  const t = (v: number) => (v > 0.008856 ? Math.cbrt(v) : 7.787 * v + 16 / 116);
  const a = t((0.4124 * x + 0.3576 * y + 0.1805 * z) / 0.95047),
    c = t(0.2126 * x + 0.7152 * y + 0.0722 * z),
    d = t((0.0193 * x + 0.1192 * y + 0.9505 * z) / 1.08883);
  return [116 * c - 16, 500 * (a - c), 200 * (c - d)];
}
export const rgb = PALETTE.map((c) =>
  [1, 3, 5].map((i) => parseInt(c.hex.slice(i, i + 2), 16)),
);
export const colors = rgb.map((c) => lab(c[0], c[1], c[2]));
export function match(r: number, g: number, b: number) {
  const p = lab(r, g, b);
  let index = 0,
    best = Infinity;
  colors.forEach((c, i) => {
    const dist =
      0.5 * (c[0] - p[0]) ** 2 + (c[1] - p[1]) ** 2 + (c[2] - p[2]) ** 2;
    if (dist < best) {
      best = dist;
      index = i;
    }
  });
  return index;
}

import {
  finishModel,
  nearestColor,
  PALETTE,
  validateModel,
  type Model,
  type Raster,
} from './brick-engine.ts';
import { groupImageAssembly } from './image-design.ts';
import { referenceMask } from './reference-colors.ts';

// Reading a brick facade instead of guessing a volume. A straight-on picture of
// a LEGO model already contains the answer: the stud pitch fixes the scale, the
// dark joints between pieces give the brick boundaries, and the middle of each
// piece gives its colour. Nothing here is generative.
export type ReadBrick = {
  // Stud columns in X, plate rows in Y, measured from the bottom left.
  x: number;
  y: number;
  w: number;
  h: number;
  color: number;
};
export type Blueprint = {
  bricks: ReadBrick[];
  // One colour per stud column and plate row, 255 where nothing was read. The
  // model paints these, so a mis-merged piece cannot flatten a whole region.
  cells: Uint8Array;
  studs: number;
  plates: number;
  pitch: number;
  platePitch: number;
  seamContrast: number;
};
// Exposed so the interface can offer a stud count before converting.
export function estimatePitch(image: Raster) {
  const { mask, left, right, top, bottom } = referenceMask(image);
  return studPitch(image, mask, left, right, top, bottom, luminance(image));
}
export type ReadOptions = {
  // Studs across the longest side of the model when it is converted.
  resolution?: number;
  // Manually override the detected stud pitch, in source pixels.
  pitch?: number;
};
const clamp = (v: number, lo: number, hi: number) =>
  Math.max(lo, Math.min(hi, v));
function luminance(image: Raster) {
  const { width, height, data } = image,
    out = new Float32Array(width * height);
  for (let i = 0; i < out.length; i++)
    out[i] =
      0.2126 * data[i * 4] +
      0.7152 * data[i * 4 + 1] +
      0.0722 * data[i * 4 + 2];
  return out;
}
// Period of a repeating signal, found by autocorrelation. The smallest lag
// carrying most of the best score wins, so a harmonic is never mistaken for the
// pitch itself.
function period(signal: Float32Array, min: number, max: number) {
  const n = signal.length;
  if (n < min * 2) return 0;
  const mean = signal.reduce((s, v) => s + v, 0) / n;
  let best = -Infinity,
    scores = new Float32Array(max + 1);
  for (let lag = min; lag <= max; lag++) {
    let sum = 0;
    for (let i = 0; i + lag < n; i++)
      sum += (signal[i] - mean) * (signal[i + lag] - mean);
    scores[lag] = sum / (n - lag);
    best = Math.max(best, scores[lag]);
  }
  if (best <= 0) return 0;
  for (let lag = min; lag <= max; lag++)
    if (scores[lag] >= best * 0.85) return lag;
  return max;
}
// Strongest repeating period across horizontal bands, with its correlation.
function studPitch(
  image: Raster,
  mask: Uint8Array,
  left: number,
  right: number,
  top: number,
  bottom: number,
  lum: Float32Array,
) {
  const { width } = image,
    spanX = right - left + 1,
    bands = 18;
  let best = 0,
    bestScore = 0;
  for (let band = 0; band < bands; band++) {
    const y0 = top + Math.floor((band * (bottom - top + 1)) / bands),
      y1 = top + Math.floor(((band + 1) * (bottom - top + 1)) / bands) - 1;
    if (y1 <= y0) continue;
    const signal = new Float32Array(spanX);
    for (let x = left; x <= right; x++) {
      let sum = 0,
        count = 0;
      for (let y = y0; y <= y1; y++) {
        const i = y * width + x;
        if (!mask[i]) continue;
        sum += 255 - lum[i];
        count++;
      }
      signal[x - left] = count ? sum / count : 0;
    }
    const filtered = highPass(signal, 2),
      candidate = period(filtered, 4, Math.max(6, Math.floor(spanX / 2.5)));
    if (!candidate) continue;
    const score = correlation(filtered, candidate);
    if (score > bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  return { pitch: best, confidence: bestScore };
}
function correlation(signal: Float32Array, lag: number) {
  const n = signal.length,
    mean = signal.reduce((s, v) => s + v, 0) / n;
  let sum = 0,
    a = 0,
    b = 0;
  for (let i = 0; i + lag < n; i++) {
    const x = signal[i] - mean,
      y = signal[i + lag] - mean;
    sum += x * y;
    a += x * x;
    b += y * y;
  }
  return a && b ? sum / Math.sqrt(a * b) : 0;
}
function highPass(signal: Float32Array, radius: number) {
  const out = new Float32Array(signal.length),
    window = radius * 2 + 1;
  let running = 0;
  for (let i = 0; i < signal.length + radius; i++) {
    const add = i < signal.length ? signal[i] : 0;
    running += add;
    if (i >= window) running -= signal[i - window];
    const at = i - radius;
    if (at >= 0 && at < signal.length)
      out[at] = signal[at] - running / Math.min(window, i + 1);
  }
  return out;
}
export function readFront(image: Raster, options: ReadOptions = {}): Blueprint {
  const { mask, left, right, top, bottom } = referenceMask(image),
    { width, height } = image,
    lum = luminance(image);
  const spanX = right - left + 1,
    spanY = bottom - top + 1,
    darkness = (x: number, y: number) =>
      x < 0 || y < 0 || x >= width || y >= height || !mask[y * width + x]
        ? -1
        : 255 - lum[y * width + x];
  // Stud pitch. Brick joints alone cannot give it: a four stud brick and four
  // one stud bricks have identical joints. The studs on horizontal surfaces can,
  // so the pitch is taken from the horizontal band whose repeating signal is
  // strongest, which is normally the top of the base plate.
  const estimate = options.pitch
      ? { pitch: options.pitch, confidence: 1 }
      : studPitch(image, mask, left, right, top, bottom, lum),
    pitch = estimate.pitch;
  if (!pitch || estimate.confidence < 0.35)
    throw Error(
      estimate.pitch
        ? `凸点间距识别不可靠（置信度 ${estimate.confidence.toFixed(2)}）。请在下方手动填写正面宽度（凸点数），或换一张能看到底板凸点的正面图。`
        : '没有在正面图里找到重复的凸点间距，请在下方手动填写正面宽度（凸点数）。',
    );
  // The grid is anchored to the silhouette: on a straight-on view of a brick
  // model the outermost stud columns are exactly the outline, so searching for a
  // phase only invites an off-by-one-stud answer.
  const columnAt = (k: number) => left + k * pitch,
    studs = clamp(Math.round(spanX / pitch), 2, 200);
  // A plate is 0.4 of a stud, so the row grid follows from the stud pitch.
  // A plate is 0.4 of a stud, but that pitch must stay fractional: rounding it
  // drifts the row grid by nearly half a plate over a tall facade, which merges
  // courses and hides their joints.
  const plate = Math.max(2, pitch * 0.4);
  const rowAt = (k: number) => top + k * plate,
    plates = clamp(Math.round(spanY / plate), 3, 400);
  // A joint is judged against the faces on both sides of it. The whole course is
  // scanned: a horizontal boundary inside the course darkens the seam and the
  // faces alike, so it cancels out, while trimming rows away would also cut the
  // rows where the vertical joint is drawn. It is looked for
  // within a couple of pixels of the grid line, because the drawn joint sits on
  // one side of the boundary rather than exactly on it.
  // A joint is judged against the faces on both sides of it. Rows that are dark
  // all the way across are the course's own horizontal boundary, not the joint
  // being looked for, so they are skipped; the search window is a third of a stud
  // wide because the grid can sit a pixel or two off the drawn joint.
  const joint = (line: number, from: number, to: number, along: 'x' | 'y') => {
    const half = Math.round((along === 'x' ? pitch : plate) * 0.5);
    const boundary = new Set<number>();
    if (along === 'x') {
      const means: number[] = [];
      for (let at = from; at <= to; at++) {
        let sum = 0,
          count = 0;
        for (let x = left; x <= right; x++) {
          const d = darkness(x, at);
          if (d < 0) continue;
          sum += d;
          count++;
        }
        means.push(count ? sum / count : 0);
      }
      const sorted = [...means].sort((a, b) => a - b),
        median = sorted[Math.floor(sorted.length / 2)] || 0;
      means.forEach((mean, i) => {
        if (mean > median + 6) boundary.add(from + i);
      });
    }
    const reach = Math.max(
      3,
      Math.round((along === 'x' ? pitch : plate) * 0.3),
    );
    let seam = 0,
      face = 0,
      n = 0;
    for (let at = from; at <= to; at++) {
      if (boundary.has(at)) continue;
      let darkest = -1;
      for (let d = -reach; d <= reach; d++)
        darkest = Math.max(
          darkest,
          along === 'x' ? darkness(line + d, at) : darkness(at, line + d),
        );
      const a =
          along === 'x' ? darkness(line - half, at) : darkness(at, line - half),
        b =
          along === 'x' ? darkness(line + half, at) : darkness(at, line + half);
      if (darkest < 0 || a < 0 || b < 0) continue;
      seam += darkest;
      face += (a + b) / 2;
      n++;
    }
    return n ? (seam - face) / n : 0;
  };
  const baseline = (values: number[]) => {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length * 0.6)] || 0;
  };
  // Threshold for one course or band. Three rules were judged on a soft-lit
  // reference facade with low contrast joints: a share of the strongest joint,
  // a medians-versus-maximum rule, and an Otsu two-cluster split. The first two
  // are documented in the README; all three read only four of seven pieces
  // there, so the threshold is NOT what limits a soft render. The share rule is
  // kept because it also recovers the hard-joint facade piece for piece.
  const localLimit = (values: number[]) =>
    Math.max(4, Math.max(...values, 0) * 0.25);
  // Row bands: a joint only where the facade really shows a horizontal seam.
  const rowLine = Array.from({ length: plates + 1 }, (_, k) =>
      joint(Math.round(rowAt(k)), left, right, 'y'),
    ),
    rowLimit = localLimit(rowLine.slice(1, -1)),
    // A band shorter than a brick is a misread joint, not a piece: merge it up.
    cutsRow = (() => {
      const raw = rowLine.map((s, k) => k > 0 && k < plates && s >= rowLimit),
        kept: number[] = [];
      for (let k = 1; k < plates; k++)
        if (raw[k] && k - (kept.at(-1) || 0) >= 3) kept.push(k);
      while (kept.length && plates - kept[kept.length - 1] < 3) kept.pop();
      return kept;
    })();
  const cellColor = (column: number, row: number) => {
    const x0 = Math.round(columnAt(column) + pitch * 0.3),
      x1 = Math.round(columnAt(column + 1) - pitch * 0.3),
      y0 = Math.round(rowAt(row) + plate * 0.3),
      y1 = Math.round(rowAt(row + 1) - plate * 0.3);
    const votes = new Uint32Array(PALETTE.length);
    let n = 0;
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) {
        if (x < 0 || y < 0 || x >= width || y >= height) continue;
        const i = y * width + x;
        if (!mask[i]) continue;
        votes[
          nearestColor(
            image.data[i * 4],
            image.data[i * 4 + 1],
            image.data[i * 4 + 2],
            true,
          )
        ]++;
        n++;
      }
    if (!n) return -1;
    let best = 0;
    for (let c = 1; c < votes.length; c++) if (votes[c] > votes[best]) best = c;
    return best;
  };
  const bricks: ReadBrick[] = [],
    cells = new Uint8Array(studs * plates).fill(255);
  let row = 0,
    boundary = 0;
  while (row < plates) {
    const end = boundary < cutsRow.length ? cutsRow[boundary] : plates;
    boundary++;
    // Vertical joints are judged inside this course only: a joint exists where
    // one piece ends, not over the whole facade.
    const line = Array.from({ length: studs + 1 }, (_, k) =>
        k > 0 && k < studs
          ? joint(
              Math.round(columnAt(k)),
              Math.round(rowAt(row)),
              Math.round(rowAt(end)),
              'x',
            )
          : 0,
      ),
      limit = localLimit(line.slice(1, -1));
    let start = 0;
    for (let k = 1; k <= studs; k++) {
      if (k < studs && line[k] < limit) continue;
      const votes = new Uint32Array(PALETTE.length);
      let n = 0;
      for (let r = row; r < end; r++)
        for (let c = start; c < k; c++) {
          const colour = cellColor(c, r);
          if (colour < 0) continue;
          votes[colour]++;
          // Rows count from the top here; the model counts from the bottom.
          cells[c * plates + (plates - 1 - r)] = colour;
          n++;
        }
      if (n) {
        let best = 0;
        for (let c = 1; c < votes.length; c++)
          if (votes[c] > votes[best]) best = c;
        bricks.push({
          x: start,
          y: plates - end,
          w: k - start,
          h: end - row,
          color: best,
        });
      }
      start = k;
    }
    row = end;
  }
  if (!bricks.length)
    throw Error('正面图里没有读出可用的砖块，请换更清晰的正面图。');
  // A single cell whose colour appears nowhere around it is a highlight or a
  // joint that was sampled by mistake: fold it into what surrounds it. Real
  // features are several cells wide and survive.
  const around: number[] = [];
  for (let pass = 0; pass < 2; pass++) {
    const next = new Uint8Array(cells);
    for (let y = 0; y < plates; y++)
      for (let x = 0; x < studs; x++) {
        const own = cells[x * plates + y];
        if (own === 255) continue;
        // Only highlights are folded away; a genuinely dark cell (a shadow, an
        // opening, a tree) is a feature, not noise.
        const name = PALETTE[own].name;
        if (name !== '白色' && name !== '浅灰色') continue;
        around.length = 0;
        let same = 0;
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            if (!dx && !dy) continue;
            const nx = x + dx,
              ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= studs || ny >= plates) continue;
            const colour = cells[nx * plates + ny];
            if (colour === 255) continue;
            around.push(colour);
            if (colour === own) same++;
          }
        if (same >= 2 || around.length < 3) continue;
        const votes = new Uint32Array(PALETTE.length);
        for (const colour of around) votes[colour]++;
        let best = 0;
        for (let c = 1; c < votes.length; c++)
          if (votes[c] > votes[best]) best = c;
        next[x * plates + y] = best;
      }
    cells.set(next);
  }
  // Unread cells take the colour the piece was read as, so folding a highlight
  // away never repaints the whole piece.
  for (const brick of bricks) {
    const votes = new Uint32Array(PALETTE.length);
    for (let dx = 0; dx < brick.w; dx++)
      for (let dy = 0; dy < brick.h; dy++) {
        const y = brick.y + dy;
        if (brick.x + dx >= studs || y >= plates) continue;
        const colour = cells[(brick.x + dx) * plates + y];
        if (colour !== 255) votes[colour]++;
      }
    let best = -1;
    for (let c = 0; c < votes.length; c++)
      if (votes[c] > (best < 0 ? 0 : votes[best])) best = c;
    if (best >= 0) brick.color = best;
  }
  return {
    bricks,
    cells,
    studs,
    plates,
    pitch,
    platePitch: plate,
    seamContrast: estimate.confidence,
  };
}
// The read face becomes the front of a solid body. Only that face is known, so
// the depth is an assumption and the interior keeps the dominant material.
export function blueprintToModel(
  blueprint: Blueprint,
  depth: number,
  resolution: number,
  name = '正面图纸',
): Model {
  const { bricks, studs, plates } = blueprint,
    w = Math.max(2, studs % 2 ? studs + 1 : studs),
    d = Math.max(2, 2 * Math.round(depth / 2)),
    h = Math.max(3, plates);
  if (![20, 28, 36, 48].includes(resolution))
    throw Error('正面图纸只支持 20 / 28 / 36 / 48 凸点尺寸。');
  if (w > resolution * 1.5)
    throw Error(
      `识别到 ${studs} 凸点宽，超过所选尺寸能表示的宽度，请提高积木尺寸。`,
    );
  const counts = new Uint32Array(PALETTE.length);
  for (const b of bricks) counts[b.color]++;
  const dominant = counts.indexOf(Math.max(...counts));
  const cells = new Map<string, { color: number; support: boolean }>();
  // Solid body: the front face carries the read colours, everything behind it is
  // the main material of the facade.
  for (let y = 2; y < h + 2; y++)
    for (let x = 0; x < w; x++)
      for (let z = 0; z < d; z++)
        cells.set(`${x},${y},${z}`, { color: dominant, support: false });
  const paint = new Map<string, number>();
  for (const b of bricks)
    for (let dx = 0; dx < b.w; dx++)
      for (let dy = 0; dy < b.h; dy++)
        paint.set(`${b.x + dx},${b.y + dy}`, b.color);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      // Prefer the colour read for this exact cell; a piece only fills in where
      // the cell itself could not be read.
      const own =
        x < blueprint.studs && y < blueprint.plates
          ? blueprint.cells[x * blueprint.plates + y]
          : 255;
      const colour = own === 255 ? paint.get(`${x},${y}`) : own;
      if (colour === undefined) continue;
      for (let z = Math.max(0, d - 2); z < d; z++)
        cells.set(`${x},${y + 2},${z}`, { color: colour, support: false });
    }
  const raw = finishModel(
    cells,
    w,
    h + 2,
    d,
    'image',
    name,
    resolution,
    dominant,
  );
  if (raw.bricks.length > 14000)
    throw Error('此尺寸超过 14000 块零件，请降低积木尺寸后再转换。');
  const model = groupImageAssembly(raw);
  model.blueprintDesign = {
    method: 'face-reading',
    bricks: bricks.length,
    studs,
    depth: d,
    pitch: blueprint.pitch,
  };
  model.assembly!.reference = `正面按参考图的砖块排布逐块还原；侧面、背面与内部结构未从图中读到，进深 ${d} 凸点为假设值。未做实物拼装验证。`;
  const check = validateModel(model);
  if (
    check.collisions ||
    check.unsupported ||
    check.invalidParts ||
    !check.connected
  )
    throw Error(
      `读出的图纸未能装配（重叠 ${check.collisions} · 缺支撑 ${check.unsupported} · 连通 ${check.connected ? '是' : '否'}），请换更清晰的正面图或调整尺寸。`,
    );
  return model;
}

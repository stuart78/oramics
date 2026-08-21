/**
 * Finding the four corner squares.
 *
 * They are solid, they are the only solid blocks of that size on the sheet, and
 * they sit at a known rectangle. That is the whole design: a marker you can find
 * without knowing anything about the page, whose centre you can locate to well
 * under a pixel by taking a centroid, and which tells you nothing until you have
 * all four, at which point it tells you everything.
 *
 * Two passes. A shrunken copy is searched for blobs, because a phone photo is
 * twelve megapixels and none of that resolution helps decide which blobs are
 * the corner marks. The four winners are then re-centroided at full resolution,
 * where the extra pixels do help: an error in a fiducial centre is an error in
 * the homography, and that lands on every sample taken afterwards.
 */

import { FIDUCIAL, FIDUCIAL_CENTRES, PAGE } from '@oramics/template';

import { localMean, shrink, type Gray } from './image.js';
import type { Point } from './homography.js';

export interface Blob {
  centre: Point;
  /** Pixels of ink. */
  area: number;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/**
 * Ink mask by local mean, with a fixed margin.
 *
 * The margin is what stops flat paper turning into noise: over a blank region
 * every pixel is near its own neighbourhood mean, so a bare comparison makes
 * half of it ink. Only pixels a clear step darker than their surroundings count.
 */
export const inkMask = (img: Gray, radius: number, margin = 0.12): Uint8Array => {
  const mean = localMean(img, radius);
  const out = new Uint8Array(img.width * img.height);
  for (let i = 0; i < out.length; i++) out[i] = img.data[i]! < mean.data[i]! - margin ? 1 : 0;
  return out;
};

/** Connected dark regions, four-connected, with an explicit stack. */
export const blobs = (mask: Uint8Array, width: number, height: number, minArea: number): Blob[] => {
  const seen = new Uint8Array(mask.length);
  const found: Blob[] = [];
  const stack: number[] = [];

  for (let start = 0; start < mask.length; start++) {
    if (mask[start] === 0 || seen[start] === 1) continue;
    seen[start] = 1;
    stack.length = 0;
    stack.push(start);

    let area = 0;
    let sumX = 0;
    let sumY = 0;
    let minX = width;
    let minY = height;
    let maxX = -1;
    let maxY = -1;

    while (stack.length > 0) {
      const i = stack.pop()!;
      const x = i % width;
      const y = (i / width) | 0;
      area++;
      sumX += x;
      sumY += y;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;

      if (x > 0 && mask[i - 1] === 1 && seen[i - 1] === 0) (seen[i - 1] = 1), stack.push(i - 1);
      if (x + 1 < width && mask[i + 1] === 1 && seen[i + 1] === 0)
        (seen[i + 1] = 1), stack.push(i + 1);
      if (y > 0 && mask[i - width] === 1 && seen[i - width] === 0)
        (seen[i - width] = 1), stack.push(i - width);
      if (y + 1 < height && mask[i + width] === 1 && seen[i + width] === 0)
        (seen[i + width] = 1), stack.push(i + width);
    }

    if (area >= minArea) {
      found.push({ centre: { x: sumX / area, y: sumY / area }, area, minX, minY, maxX, maxY });
    }
  }
  return found;
};

/** Solid, square, and not a smear. Rejects text, rules and the QR in one go. */
const looksLikeAFiducial = (b: Blob): boolean => {
  const w = b.maxX - b.minX + 1;
  const h = b.maxY - b.minY + 1;
  if (w < 3 || h < 3) return false;
  const aspect = w > h ? w / h : h / w;
  if (aspect > 1.45) return false;
  // A filled square fills its own bounding box. A glyph or a corner of the QR
  // does not, and neither does a ring or an L.
  return b.area / (w * h) > 0.72;
};

/** Clockwise from the top left, matching FIDUCIAL_CENTRES. */
const order = (quad: Point[]): Point[] => {
  const cx = quad.reduce((s, p) => s + p.x, 0) / quad.length;
  const cy = quad.reduce((s, p) => s + p.y, 0) / quad.length;
  const byAngle = [...quad].sort(
    (a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx),
  );
  // atan2 starts at due east and runs clockwise in image coordinates, so the
  // first point past -pi is the one up and to the left.
  const top = byAngle.reduce((best, p, i) => {
    const s = p.x + p.y;
    return s < byAngle[best]!.x + byAngle[best]!.y ? i : best;
  }, 0);
  return [0, 1, 2, 3].map((i) => byAngle[(top + i) % 4]!);
};

const quadArea = (q: Point[]): number => {
  let acc = 0;
  for (let i = 0; i < q.length; i++) {
    const a = q[i]!;
    const b = q[(i + 1) % q.length]!;
    acc += a.x * b.y - b.x * a.y;
  }
  return Math.abs(acc) / 2;
};

/** How far a quad's side-length ratio is from the reference rectangle's. */
const shapeError = (q: Point[]): number => {
  const side = (a: Point, b: Point): number => Math.hypot(a.x - b.x, a.y - b.y);
  const top = side(q[0]!, q[1]!);
  const right = side(q[1]!, q[2]!);
  const bottom = side(q[2]!, q[3]!);
  const left = side(q[3]!, q[0]!);
  if (Math.min(top, right, bottom, left) < 1e-6) return Infinity;

  const expected =
    (PAGE.widthMm - 2 * FIDUCIAL.insetMm) / (PAGE.heightMm - 2 * FIDUCIAL.insetMm);
  const got = (top + bottom) / (left + right);
  // Opposite sides also have to be roughly equal. A perspective view skews them
  // a little; a wrong set of four blobs skews them a lot.
  return (
    Math.abs(Math.log(got / expected)) +
    Math.abs(Math.log(top / bottom)) +
    Math.abs(Math.log(left / right))
  );
};

/**
 * Recompute a centre using every pixel of the blob at full resolution.
 *
 * The blob search runs on a shrunken copy, where a centre is only good to about
 * half a source pixel per shrink step. A centroid over the full-resolution ink
 * is good to a small fraction of a pixel, and since these four points define the
 * map for the whole sheet, that error would otherwise be spent everywhere.
 */
const refine = (img: Gray, mask: Uint8Array, approx: Point, expected: number): Point => {
  const radius = expected * 1.1;
  const x0 = Math.max(0, Math.round(approx.x - radius));
  const x1 = Math.min(img.width - 1, Math.round(approx.x + radius));
  const y0 = Math.max(0, Math.round(approx.y - radius));
  const y1 = Math.min(img.height - 1, Math.round(approx.y + radius));

  /*
   * Flood fill from the middle of the mark, rather than averaging a box.
   *
   * The top-right fiducial sits 3.6 mm from the QR, and a box wide enough to
   * hold the whole square also holds the edge of the symbol. That dragged its
   * centroid several pixels towards the QR while the other three came out
   * sub-pixel, and a single corner pulled sideways tilts the map across the
   * entire sheet: it was worth 1.8 mm at the far edge. The QR is not connected
   * to the square, so a fill cannot reach it however close it gets.
   */
  const seed = findInk(mask, img.width, approx, Math.max(2, Math.round(expected * 0.35)), x0, x1, y0, y1);
  if (!seed) return approx;

  const seen = new Set<number>();
  const stack = [seed];
  seen.add(seed);
  let sumX = 0;
  let sumY = 0;
  let n = 0;
  const limit = expected * expected * 4;

  while (stack.length > 0) {
    const i = stack.pop()!;
    const x = i % img.width;
    const y = (i / img.width) | 0;
    sumX += x;
    sumY += y;
    n++;
    // A fill that runs away has found a shadow or a page edge, not a mark.
    if (n > limit) return approx;

    for (const j of [x > x0 ? i - 1 : -1, x < x1 ? i + 1 : -1, y > y0 ? i - img.width : -1, y < y1 ? i + img.width : -1]) {
      if (j < 0 || mask[j] === 0 || seen.has(j)) continue;
      seen.add(j);
      stack.push(j);
    }
  }

  return n > 0 ? { x: sumX / n, y: sumY / n } : approx;
};

/** Nearest ink pixel to a point, searched outward, so the fill starts on the mark. */
const findInk = (
  mask: Uint8Array,
  width: number,
  from: Point,
  radius: number,
  x0: number,
  x1: number,
  y0: number,
  y1: number,
): number | null => {
  const cx = Math.round(from.x);
  const cy = Math.round(from.y);
  for (let r = 0; r <= radius; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const x = cx + dx;
        const y = cy + dy;
        if (x < x0 || x > x1 || y < y0 || y > y1) continue;
        const i = y * width + x;
        if (mask[i] === 1) return i;
      }
    }
  }
  return null;
};

export interface FiducialResult {
  /** Image-space centres, ordered to match FIDUCIAL_CENTRES. */
  corners: Point[];
  /** Detected side length in pixels, which is the sheet's scale. */
  sizePx: number;
  /** Every square-ish blob considered, for diagnostics. */
  candidates: Blob[];
}

export interface FindOptions {
  /** Longest edge the blob search runs at. Larger is slower, not better. */
  workingSize?: number;
  /** Ink margin below the local mean. Lower finds fainter marks and more noise. */
  margin?: number;
}

/**
 * Locate the four corner squares, or return null.
 *
 * Null is a real answer and the caller has to handle it: the sheet was folded
 * over a corner, the flash blew one out, someone photographed three quarters of
 * the page. Guessing at three points would produce a map that looks plausible
 * and puts every extracted lane in the wrong place.
 */
export const findFiducials = (img: Gray, opts: FindOptions = {}): FiducialResult | null => {
  const working = opts.workingSize ?? 900;
  const factor = Math.max(1, Math.round(Math.max(img.width, img.height) / working));
  const small = shrink(img, factor);

  /*
   * The window has to be wider than a fiducial or the square reads as its own
   * background and disappears. A fiducial is 8 mm on a 355.6 mm page.
   *
   * Measured against the longer edge of both, not the width of both. A sheet
   * photographed in portrait puts the page's long side down the image, and
   * comparing widths then underestimates the mark by the page's aspect ratio:
   * the search window comes out too small, the centroids drift, and the map
   * that follows is subtly wrong all the way down the page.
   */
  const longEdge = Math.max(small.width, small.height);
  const expectedPx = (FIDUCIAL.sizeMm / PAGE.widthMm) * longEdge;
  const mask = inkMask(small, Math.max(4, Math.round(expectedPx * 1.6)), opts.margin ?? 0.12);

  const minArea = Math.max(9, (expectedPx * expectedPx) / 6);
  const candidates = blobs(mask, small.width, small.height, minArea).filter(looksLikeAFiducial);
  if (candidates.length < 4) return null;

  // Prefer the biggest sensible quadrilateral. On a sheet photographed with
  // clutter around it, the corner marks are the outermost square blobs, and any
  // four-of-n search that ignored area would happily pick four letters instead.
  const ranked = [...candidates].sort((a, b) => b.area - a.area).slice(0, 12);
  let best: Point[] | null = null;
  let bestScore = Infinity;
  for (let i = 0; i < ranked.length; i++) {
    for (let j = i + 1; j < ranked.length; j++) {
      for (let k = j + 1; k < ranked.length; k++) {
        for (let l = k + 1; l < ranked.length; l++) {
          const quad = order([ranked[i]!, ranked[j]!, ranked[k]!, ranked[l]!].map((b) => b.centre));
          const area = quadArea(quad);
          if (area < (small.width * small.height) / 25) continue;
          const score = shapeError(quad) - Math.log(area);
          if (score < bestScore) {
            bestScore = score;
            best = quad;
          }
        }
      }
    }
  }
  if (!best) return null;

  const fullExpected = (FIDUCIAL.sizeMm / PAGE.widthMm) * Math.max(img.width, img.height);
  const fullMask = inkMask(img, Math.max(4, Math.round(fullExpected * 1.6)), opts.margin ?? 0.12);
  const corners = best.map((p) =>
    refine(img, fullMask, { x: p.x * factor, y: p.y * factor }, fullExpected),
  );

  const sides = [0, 1, 2, 3].map((i) => {
    const a = corners[i]!;
    const b = corners[(i + 1) % 4]!;
    return Math.hypot(a.x - b.x, a.y - b.y);
  });
  const spanX = (sides[0]! + sides[2]!) / 2;
  const sizePx = (spanX / (PAGE.widthMm - 2 * FIDUCIAL.insetMm)) * FIDUCIAL.sizeMm;

  return { corners, sizePx, candidates };
};

/** Where the four centres live in page millimetres. */
export const FIDUCIAL_PAGE_POINTS: Point[] = FIDUCIAL_CENTRES.map((c) => ({ x: c.x, y: c.y }));

/**
 * The projective map from image pixels to page millimetres.
 *
 * This is the whole reason the sheet carries four corner squares. Solve the map
 * once and print scale, scan DPI, page skew, the angle you held the phone at
 * and most lens distortion all drop out together. Nothing downstream ever
 * measures a millimetre off the paper; it asks for a page coordinate and gets
 * the pixel that landed there.
 *
 * A plane photographed by a pinhole camera maps to the image by a homography
 * exactly, so four point correspondences determine it with nothing left over.
 * Barrel distortion is the part this does not model, and on a flat sheet filling
 * a modern phone frame it is worth well under a millimetre at the edges.
 */

export interface Point {
  x: number;
  y: number;
}

/** Row-major 3x3, with h[8] normalised to 1. */
export type Matrix3 = Float64Array;

/**
 * Solve a dense linear system by Gaussian elimination with partial pivoting.
 *
 * Eight unknowns, so the cubic cost is irrelevant and the pivoting is what
 * matters: without it a correspondence that happens to sit at x = 0 puts a zero
 * on the diagonal and the whole solve returns NaN.
 */
const solve = (a: number[][], b: number[]): number[] | null => {
  const n = b.length;
  for (let col = 0; col < n; col++) {
    let best = col;
    for (let row = col + 1; row < n; row++) {
      if (Math.abs(a[row]![col]!) > Math.abs(a[best]![col]!)) best = row;
    }
    if (Math.abs(a[best]![col]!) < 1e-12) return null; // Degenerate: points collinear.
    [a[col], a[best]] = [a[best]!, a[col]!];
    [b[col], b[best]] = [b[best]!, b[col]!];

    const pivot = a[col]![col]!;
    for (let row = col + 1; row < n; row++) {
      const factor = a[row]![col]! / pivot;
      if (factor === 0) continue;
      for (let k = col; k < n; k++) a[row]![k]! -= factor * a[col]![k]!;
      b[row]! -= factor * b[col]!;
    }
  }

  const x = new Array<number>(n).fill(0);
  for (let row = n - 1; row >= 0; row--) {
    let acc = b[row]!;
    for (let k = row + 1; k < n; k++) acc -= a[row]![k]! * x[k]!;
    x[row] = acc / a[row]![row]!;
  }
  return x;
};

/**
 * The homography taking each `from` point to the matching `to` point.
 *
 * Returns null when the four points do not determine one, which in practice
 * means three of the detected fiducials were collinear or two were the same
 * blob found twice.
 */
export const solveHomography = (from: Point[], to: Point[]): Matrix3 | null => {
  if (from.length !== 4 || to.length !== 4) return null;

  const a: number[][] = [];
  const b: number[] = [];
  for (let i = 0; i < 4; i++) {
    const { x, y } = from[i]!;
    const { x: u, y: v } = to[i]!;
    a.push([x, y, 1, 0, 0, 0, -u * x, -u * y]);
    b.push(u);
    a.push([0, 0, 0, x, y, 1, -v * x, -v * y]);
    b.push(v);
  }

  const h = solve(a, b);
  if (!h || h.some((v) => !Number.isFinite(v))) return null;
  return Float64Array.from([...h, 1]);
};

export const apply = (h: Matrix3, p: Point): Point => {
  const w = h[6]! * p.x + h[7]! * p.y + h[8]!;
  return {
    x: (h[0]! * p.x + h[1]! * p.y + h[2]!) / w,
    y: (h[3]! * p.x + h[4]! * p.y + h[5]!) / w,
  };
};

/** The map back the other way. */
export const invert = (h: Matrix3): Matrix3 | null => {
  const [a, b, c, d, e, f, g, i, j] = h as unknown as number[];
  const A = e! * j! - f! * i!;
  const B = f! * g! - d! * j!;
  const C = d! * i! - e! * g!;
  const det = a! * A + b! * B + c! * C;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-18) return null;

  const out = Float64Array.from([
    A,
    c! * i! - b! * j!,
    b! * f! - c! * e!,
    B,
    a! * j! - c! * g!,
    c! * d! - a! * f!,
    C,
    b! * g! - a! * i!,
    a! * e! - b! * d!,
  ]);
  for (let k = 0; k < 9; k++) out[k]! /= det;
  // Renormalise so callers can compare matrices and so `apply` divides by
  // something near 1 rather than by a number that has drifted with the scale.
  if (Math.abs(out[8]!) > 1e-18) for (let k = 0; k < 9; k++) out[k]! /= out[8]!;
  return out;
};

/** Worst corner error, in the units of `to`. A sanity check on a fit. */
export const residual = (h: Matrix3, from: Point[], to: Point[]): number => {
  let worst = 0;
  for (let i = 0; i < from.length; i++) {
    const p = apply(h, from[i]!);
    worst = Math.max(worst, Math.hypot(p.x - to[i]!.x, p.y - to[i]!.y));
  }
  return worst;
};

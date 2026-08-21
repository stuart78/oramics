/**
 * Fake scans, for testing the importer without a scanner.
 *
 * A real photograph is the honest test and there is no substitute for one, but
 * it is a poor thing to build against: you cannot ask it what the lane values
 * were supposed to be. Here the sheet is rendered from the same template code
 * the printer uses, with known overlays, then put through the things a camera
 * does to it. Whatever comes back out has a right answer to be compared with.
 *
 * What gets simulated is the list of things that actually break extraction:
 * perspective, because nobody holds a phone square to the paper; a lighting
 * gradient, because one side of the page is nearer the window; blur, because
 * autofocus; and sensor noise. Not simulated: fold shadows, motion blur, a
 * finger over a corner. Those are why `findFiducials` is allowed to give up.
 */

import { apply, solveHomography, type Matrix3, type Point } from './homography.js';
import { sample, type Gray } from './image.js';

/** Parse the binary PGM that `pdftoppm -gray` writes. */
export const parsePgm = (bytes: Uint8Array): Gray => {
  let at = 0;
  const token = (): string => {
    while (at < bytes.length) {
      const c = bytes[at]!;
      if (c === 35) {
        while (at < bytes.length && bytes[at] !== 10) at++;
      } else if (c === 32 || c === 9 || c === 10 || c === 13) {
        at++;
      } else break;
    }
    const start = at;
    while (at < bytes.length && ![32, 9, 10, 13].includes(bytes[at]!)) at++;
    return String.fromCharCode(...bytes.subarray(start, at));
  };

  if (token() !== 'P5') throw new Error('not a binary PGM');
  const width = Number(token());
  const height = Number(token());
  const max = Number(token());
  at++; // Exactly one whitespace byte separates the header from the raster.

  const data = new Float32Array(width * height);
  for (let i = 0; i < data.length; i++) data[i] = bytes[at + i]! / max;
  return { data, width, height };
};

export interface CameraOptions {
  /** Output size. A phone photo of a sheet on a desk is mostly sheet. */
  width?: number;
  height?: number;
  /** How far the corners wander, as a fraction of the output size. */
  perspective?: number;
  /** Rotation in degrees. */
  rotate?: number;
  /** Depth of the lighting gradient, 0 to 1. */
  vignette?: number;
  /** Standard deviation of the sensor noise, in luminance units. */
  noise?: number;
  /** Radius of the focus blur, in output pixels. */
  blur?: number;
  /** Deterministic, so a failure can be reproduced. */
  seed?: number;
};

const mulberry32 = (seed: number): (() => number) => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const blurGray = (img: Gray, radius: number): Gray => {
  const r = Math.round(radius);
  if (r < 1) return img;
  const { width: w, height: h } = img;
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  const n = r * 2 + 1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let k = -r; k <= r; k++) {
        const xx = Math.min(w - 1, Math.max(0, x + k));
        acc += img.data[y * w + xx]!;
      }
      tmp[y * w + x] = acc / n;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let k = -r; k <= r; k++) {
        const yy = Math.min(h - 1, Math.max(0, y + k));
        acc += tmp[yy * w + x]!;
      }
      out[y * w + x] = acc / n;
    }
  }
  return { data: out, width: w, height: h };
};

export interface FakeScan {
  image: Gray;
  /** Where the source corners ended up, so a test can check the recovered ones. */
  corners: Point[];
}

/**
 * Photograph a rendered sheet.
 *
 * Works backwards, as image warps must: for each output pixel, find where it
 * came from in the source and sample there. Mapping forwards would leave holes
 * wherever the projection stretched the image.
 */
export const photograph = (sheet: Gray, opts: CameraOptions = {}): FakeScan => {
  const width = opts.width ?? 1600;
  const height = opts.height ?? Math.round((width * sheet.height) / sheet.width);
  const rand = mulberry32(opts.seed ?? 1);

  const skew = opts.perspective ?? 0.04;
  const angle = ((opts.rotate ?? 0) * Math.PI) / 180;
  const jitter = (): number => (rand() - 0.5) * 2 * skew;

  // Leave a margin so the sheet does not run out of the frame; a photo with a
  // corner cropped off is a different test, and one the importer should fail.
  const pad = 0.08;
  const base: Point[] = [
    { x: width * pad, y: height * pad },
    { x: width * (1 - pad), y: height * pad },
    { x: width * (1 - pad), y: height * (1 - pad) },
    { x: width * pad, y: height * (1 - pad) },
  ];
  const cx = width / 2;
  const cy = height / 2;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const rotated = base.map((p) => {
    const dx = p.x - cx + width * jitter();
    const dy = p.y - cy + height * jitter();
    return { x: cx + dx * cos - dy * sin, y: cy + dx * sin + dy * cos };
  });

  /*
   * Pull the sheet back inside the frame.
   *
   * Rotating a rectangle that already fills most of the picture pushes its
   * corners out, and a corner off the edge of the photo is a sheet with a
   * missing fiducial. That is a real failure mode and worth a test of its own,
   * but it is not what a rotation test is asking about, and leaving it in here
   * meant every camera angle beyond a few degrees was silently testing the
   * cropped case instead.
   */
  const minX = Math.min(...rotated.map((p) => p.x));
  const maxX = Math.max(...rotated.map((p) => p.x));
  const minY = Math.min(...rotated.map((p) => p.y));
  const maxY = Math.max(...rotated.map((p) => p.y));
  const fit = Math.min(
    1,
    (width * (1 - 2 * pad)) / Math.max(1e-6, maxX - minX),
    (height * (1 - 2 * pad)) / Math.max(1e-6, maxY - minY),
  );
  const target = rotated.map((p) => ({
    x: cx + (p.x - (minX + maxX) / 2) * fit,
    y: cy + (p.y - (minY + maxY) / 2) * fit,
  }));

  const source: Point[] = [
    { x: 0, y: 0 },
    { x: sheet.width - 1, y: 0 },
    { x: sheet.width - 1, y: sheet.height - 1 },
    { x: 0, y: sheet.height - 1 },
  ];
  const toSource = solveHomography(target, source);
  if (!toSource) throw new Error('degenerate camera');

  const data = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const s = apply(toSource, { x, y });
      // Outside the paper is whatever the sheet was resting on.
      const inside = s.x >= 0 && s.y >= 0 && s.x < sheet.width && s.y < sheet.height;
      data[y * width + x] = inside ? sample(sheet, s.x, s.y) : 0.55;
    }
  }

  let img: Gray = { data, width, height };
  if (opts.blur) img = blurGray(img, opts.blur);

  const vignette = opts.vignette ?? 0.25;
  const noise = opts.noise ?? 0.01;
  if (vignette > 0 || noise > 0) {
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        // A soft diagonal ramp, which is what a window on one side looks like.
        const lit = 1 - vignette * ((x / width) * 0.6 + (y / height) * 0.4);
        const n = noise > 0 ? (rand() + rand() + rand() - 1.5) * noise : 0;
        img.data[i] = Math.min(1, Math.max(0, img.data[i]! * lit + n));
      }
    }
  }

  return { image: img, corners: target };
};

/** Map page millimetres straight to source pixels, for a render of known DPI. */
export const pageToPixels = (sheet: Gray, pageWidthMm: number): Matrix3 => {
  const scale = sheet.width / pageWidthMm;
  return Float64Array.from([scale, 0, 0, 0, scale, 0, 0, 0, 1]);
};

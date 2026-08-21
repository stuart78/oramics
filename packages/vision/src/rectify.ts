/**
 * Flattening part of a registered sheet back into an upright picture.
 *
 * Two things want this. The QR decoder wants a symbol that is square again
 * rather than one photographed at an angle. And the app wants the paper itself:
 * a lane is one value per column by the time it reaches the engine, which is
 * what the machine reads, but it is not what somebody drew. Keeping the marks
 * means keeping the pixels, registered so they land exactly on the band they
 * came from.
 */

import { apply, type Matrix3 } from './homography.js';
import { sample, type Gray } from './image.js';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** RGBA, which is what a canvas and jsQR both want. */
export interface Rectified {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

export const rectify = (
  image: Gray,
  toImage: Matrix3,
  rect: Rect,
  pixelsPerMm: number,
): Rectified => {
  const width = Math.max(1, Math.round(rect.w * pixelsPerMm));
  const height = Math.max(1, Math.round(rect.h * pixelsPerMm));
  const data = new Uint8ClampedArray(width * height * 4);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = apply(toImage, {
        x: rect.x + (rect.w * (x + 0.5)) / width,
        y: rect.y + (rect.h * (y + 0.5)) / height,
      });
      const v = Math.round(sample(image, p.x, p.y) * 255);
      const i = (y * width + x) * 4;
      data[i] = v;
      data[i + 1] = v;
      data[i + 2] = v;
      data[i + 3] = 255;
    }
  }
  return { data, width, height };
};

/**
 * Sample a region as an opacity field: 0 clear, 1 solid.
 *
 * This is the honest reading of a painted timbre. Oram's slides were glass with
 * enamel on them and the flying spot responds to the whole field — how thick the
 * paint is, where it went thin, whether there is a second ribbon overhead. A
 * drawing reduced to one height per column throws all of that away and comes
 * back as a silhouette, which is what a scribbled panel, a face, or a written
 * word turns into. Handing the engine the field instead lets it do what the
 * machine did with it.
 *
 * The curve is a soft threshold rather than a hard one, and it matters: paint
 * above about half opacity still holds the loop's lock and merely shifts where
 * it rests, so a pencil scribble reads as thin enamel and sounds rough rather
 * than dropping the spot to the rail and going quiet.
 */
export const rectifyOpacity = (
  image: Gray,
  paper: Gray,
  toImage: Matrix3,
  rect: Rect,
  width: number,
  height: number,
  inkDepth: number,
): Float32Array => {
  const out = new Float32Array(width * height);
  const low = Math.max(0.03, inkDepth * 0.12);
  const high = Math.max(low + 0.02, inkDepth * 0.55);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = apply(toImage, {
        x: rect.x + (rect.w * (x + 0.5)) / width,
        y: rect.y + (rect.h * (y + 0.5)) / height,
      });
      const depth = sample(paper, p.x, p.y) - sample(image, p.x, p.y);
      const t = Math.max(0, Math.min(1, (depth - low) / (high - low)));
      out[y * width + x] = t * t * (3 - 2 * t); // smoothstep
    }
  }
  return out;
};

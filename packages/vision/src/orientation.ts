/**
 * Deciding which way up the sheet was photographed.
 *
 * Four identical squares at the corners of a rectangle say where the page is
 * and nothing about which way round it is. That is not a small gap. A sheet
 * photographed in portrait registers perfectly onto its own transpose: the
 * corner fit comes out at zero, every band is sampled across the page instead
 * of along it, and the result looks like a reading of the piece rather than
 * like a failure. It took a workshop sheet to notice.
 *
 * So orientation is decided here, explicitly, rather than falling out of
 * whichever corner happened to sort first. Three things settle it, in order of
 * how much they can be trusted:
 *
 *   shape        a quarter turn squashes the long axis of the page into the
 *                short one, which no camera angle on a flat sheet does
 *   the mark     a solid bar under the top-left corner, printed for this
 *   the QR       a dense block at a known place, on every sheet ever printed
 *
 * The last of those is what makes sheets printed before the mark existed still
 * import the right way up.
 */

import { ORIENTATION_MARK, PAGE, orientationRect, qrRect } from '@oramics/template';

import { apply, invert, solveHomography, type Matrix3, type Point } from './homography.js';
import { sample, type Gray } from './image.js';
import { FIDUCIAL_PAGE_POINTS } from './fiducials.js';

export interface Orientation {
  /** The corners, rotated so index 0 is the true top left. */
  corners: Point[];
  /** Quarter turns applied to the detected order. */
  turns: number;
  /** How much better this reading was than the next best. Under ~0.02 is a guess. */
  confidence: number;
  /** Whether the printed orientation mark was found, rather than inferred. */
  explicit: boolean;
}

/** Mean ink depth over a page-space rectangle. */
const density = (
  image: Gray,
  paper: Gray,
  toImage: Matrix3,
  rect: { x: number; y: number; w: number; h: number },
  steps = 12,
): number => {
  let total = 0;
  let n = 0;
  for (let j = 0; j < steps; j++) {
    for (let i = 0; i < steps; i++) {
      const p = apply(toImage, {
        x: rect.x + (rect.w * (i + 0.5)) / steps,
        y: rect.y + (rect.h * (j + 0.5)) / steps,
      });
      if (p.x < 0 || p.y < 0 || p.x >= image.width || p.y >= image.height) continue;
      total += sample(paper, p.x, p.y) - sample(image, p.x, p.y);
      n++;
    }
  }
  return n > 0 ? total / n : 0;
};

/**
 * How far from square the map is.
 *
 * A page millimetre should be the same number of pixels along x as along y.
 * Perspective on a flat sheet bends that a little; assigning the corners a
 * quarter turn out bends it by the page's aspect ratio squared, which is nearly
 * three. Anything past about 1.8 is the wrong pair of corners, not a camera.
 */
const anisotropy = (toImage: Matrix3): number => {
  const o = apply(toImage, { x: 100, y: 100 });
  const dx = apply(toImage, { x: 110, y: 100 });
  const dy = apply(toImage, { x: 100, y: 110 });
  const sx = Math.hypot(dx.x - o.x, dx.y - o.y);
  const sy = Math.hypot(dy.x - o.x, dy.y - o.y);
  if (sx < 1e-6 || sy < 1e-6) return Infinity;
  return sx > sy ? sx / sy : sy / sx;
};

/** How much darker than its mirror the bar has to read before it counts. */
const MARK_CLEAR = 0.25;

const rotate = (corners: Point[], turns: number): Point[] =>
  [0, 1, 2, 3].map((i) => corners[(i + turns) % 4]!);

/**
 * Pick the corner assignment that reads as a sheet the right way up.
 *
 * Returns null when the four corners cannot be made into a page at all, which
 * means they were not the corners of one.
 */
export const resolveOrientation = (
  image: Gray,
  paper: Gray,
  corners: Point[],
): Orientation | null => {
  /*
   * The middle of the bar, not the whole of it.
   *
   * Its edges are soft on a photograph and its corners softer still, so
   * averaging over the printed rectangle reads well under solid even when the
   * mark is plainly there. The inner part is either solid ink or it is not.
   */
  const full = orientationRect();
  const mark = {
    x: full.x + full.w * 0.2,
    y: full.y + full.h * 0.2,
    w: full.w * 0.6,
    h: full.h * 0.6,
  };
  // Where the mark would be if the sheet were upside down. Used as a control:
  // a real mark is dark and its opposite is bare margin, and asking for both
  // stops a dark patch of background scoring as well as the mark itself.
  const opposite = {
    x: PAGE.widthMm - mark.x - mark.w,
    y: PAGE.heightMm - mark.y - mark.h,
    w: mark.w,
    h: mark.h,
  };
  const qr = qrRect();

  const scored: { turns: number; corners: Point[]; score: number; mark: number }[] = [];
  for (let turns = 0; turns < 4; turns++) {
    const candidate = rotate(corners, turns);
    const toPage = solveHomography(candidate, FIDUCIAL_PAGE_POINTS);
    const toImage = toPage ? invert(toPage) : null;
    if (!toImage) continue;
    // A quarter turn out. Rejected on shape alone, before looking at any ink.
    if (anisotropy(toImage) > 1.8) continue;

    const here = density(image, paper, toImage, mark);
    const there = density(image, paper, toImage, opposite);
    const qrInk = density(image, paper, toImage, qr, 16);

    /*
     * The mark only votes when it is unmistakably there.
     *
     * At the three pixels per millimetre a hand-held photograph puts on the
     * page, a soft reading of the bar is not evidence of anything, and letting a
     * weak one carry weight means noise in the margin can turn the page over. So
     * it is decisive when it is clear and silent when it is not, and the QR —
     * a dense block at a known place on every sheet ever printed — settles the
     * rest.
     */
    const decisive = here - there > MARK_CLEAR;
    scored.push({
      turns,
      corners: candidate,
      score: (decisive ? (here - there) * 2 : 0) + qrInk,
      mark: here - there,
    });
  }

  if (scored.length === 0) return null;
  scored.sort((a, b) => b.score - a.score);
  const best = scored[0]!;
  const runnerUp = scored[1];

  return {
    corners: best.corners,
    turns: best.turns,
    confidence: runnerUp ? best.score - runnerUp.score : 1,
    /*
     * Was the printed mark decisive, or did the QR carry it?
     *
     * Judged on the difference between the mark and its opposite rather than on
     * an absolute darkness, because the paper reference near the mark is dragged
     * down by the corner square 13 mm away: solid ink there measures well short
     * of solid. The sign and the size of the difference are what matter.
     */
    explicit: best.mark > MARK_CLEAR,
  };
};

export { ORIENTATION_MARK };

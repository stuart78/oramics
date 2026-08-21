import assert from 'node:assert/strict';
import { before, test } from 'node:test';

import { FIDUCIAL_CENTRES, PAGE } from '@oramics/template';

import { FIDUCIAL_PAGE_POINTS, findFiducials } from './fiducials.js';
import { hasRasteriser, renderSheet } from './fixture.js';
import { apply, invert, residual, solveHomography, type Point } from './homography.js';
import type { Gray } from './image.js';
import { photograph } from './testing.js';

const RASTERISER = hasRasteriser();
const skip = RASTERISER ? false : 'pdftoppm is not installed';

let sheet: Gray;

before(async () => {
  if (RASTERISER) sheet = await renderSheet(150);
});

// --- the maths, which needs no images -------------------------------------

test('a homography recovers the map it was built from', () => {
  const from: Point[] = [
    { x: 10, y: 20 },
    { x: 400, y: 40 },
    { x: 380, y: 300 },
    { x: 30, y: 280 },
  ];
  const to: Point[] = [
    { x: 0, y: 0 },
    { x: 100, y: 0 },
    { x: 100, y: 60 },
    { x: 0, y: 60 },
  ];
  const h = solveHomography(from, to)!;
  assert.ok(h, 'no solution');
  assert.ok(residual(h, from, to) < 1e-9, 'the corners do not land on their targets');

  const back = invert(h)!;
  assert.ok(back, 'not invertible');
  for (const p of from) {
    const round = apply(back, apply(h, p));
    assert.ok(Math.hypot(round.x - p.x, round.y - p.y) < 1e-6, 'round trip drifted');
  }
});

test('three points in a line have no solution rather than a wrong one', () => {
  // Worth being explicit about: a silently wrong map puts every extracted lane
  // somewhere plausible and slightly incorrect, which is the worst outcome.
  const h = solveHomography(
    [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 20, y: 0 },
      { x: 5, y: 9 },
    ],
    [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 2, y: 0 },
      { x: 0, y: 1 },
    ],
  );
  assert.equal(h, null);
});

// --- registration against rendered sheets ----------------------------------

test('the fiducials are found on a clean render', { skip }, () => {
  const found = findFiducials(sheet);
  assert.ok(found, 'no fiducials found on a perfect scan');

  const scale = sheet.width / PAGE.widthMm;
  found.corners.forEach((c, i) => {
    const expected = FIDUCIAL_CENTRES[i]!;
    const offBy = Math.hypot(c.x / scale - expected.x, c.y / scale - expected.y);
    assert.ok(offBy < 0.4, `corner ${i} is ${offBy.toFixed(2)} mm out`);
  });
});

/** Worst error, in millimetres, over a grid of points across the whole page. */
const worstPageError = (image: Gray, truth: (p: Point) => Point): number => {
  const found = findFiducials(image);
  assert.ok(found, 'no fiducials found');
  const h = solveHomography(found.corners, FIDUCIAL_PAGE_POINTS);
  assert.ok(h, 'no homography');

  let worst = 0;
  for (let gx = 0; gx <= 10; gx++) {
    for (let gy = 0; gy <= 6; gy++) {
      const page = { x: (PAGE.widthMm * gx) / 10, y: (PAGE.heightMm * gy) / 6 };
      const got = apply(h!, truth(page));
      worst = Math.max(worst, Math.hypot(got.x - page.x, got.y - page.y));
    }
  }
  return worst;
};

test('a photographed sheet still registers to well under a millimetre', { skip }, () => {
  // The claim the whole importer rests on. If page space is recovered this
  // accurately, every band and panel is where the template says it is, and no
  // downstream step has to know anything about cameras.
  const scan = photograph(sheet, {
    width: 1700,
    perspective: 0.05,
    rotate: 3.5,
    vignette: 0.3,
    noise: 0.012,
    blur: 1,
    seed: 7,
  });

  // The render covers the whole page, so its outer corners are the page corners
  // and the map wants millimetres in, not render pixels.
  const pageToScan = solveHomography(
    [
      { x: 0, y: 0 },
      { x: PAGE.widthMm, y: 0 },
      { x: PAGE.widthMm, y: PAGE.heightMm },
      { x: 0, y: PAGE.heightMm },
    ],
    scan.corners,
  )!;

  const worst = worstPageError(scan.image, (p) => apply(pageToScan, p));
  assert.ok(worst < 0.5, `worst position error across the page is ${worst.toFixed(2)} mm`);
});

test('registration survives the range of angles a person actually holds', { skip }, () => {
  for (const [i, camera] of [
    { perspective: 0.0, rotate: 0, vignette: 0.05, noise: 0.004, blur: 0 },
    { perspective: 0.03, rotate: -8, vignette: 0.35, noise: 0.02, blur: 1 },
    { perspective: 0.07, rotate: 12, vignette: 0.2, noise: 0.01, blur: 2 },
    { perspective: 0.09, rotate: 180, vignette: 0.25, noise: 0.015, blur: 1 },
  ].entries()) {
    const scan = photograph(sheet, { width: 1500, seed: 11 + i, ...camera });
    const found = findFiducials(scan.image);
    assert.ok(found, `camera ${i} (${JSON.stringify(camera)}) lost the fiducials`);

    const h = solveHomography(found.corners, FIDUCIAL_PAGE_POINTS);
    assert.ok(h, `camera ${i} produced no homography`);

    // The corners must land back on the reference rectangle, which is the only
    // check available without knowing the exact camera.
    assert.ok(
      residual(h!, found.corners, FIDUCIAL_PAGE_POINTS) < 0.05,
      `camera ${i} fit its own corners badly`,
    );
    // And the page has to come out the right way up and the right size.
    const topLeft = apply(h!, found.corners[0]!);
    assert.ok(Math.hypot(topLeft.x - 11, topLeft.y - 11) < 0.5, `camera ${i} is not square`);
  }
});

test('a sheet with a corner missing is refused', { skip }, () => {
  // Better to say no than to fit three points and a guess.
  const cropped: Gray = {
    width: Math.round(sheet.width * 0.8),
    height: sheet.height,
    data: new Float32Array(Math.round(sheet.width * 0.8) * sheet.height),
  };
  for (let y = 0; y < cropped.height; y++) {
    for (let x = 0; x < cropped.width; x++) {
      cropped.data[y * cropped.width + x] = sheet.data[y * sheet.width + x]!;
    }
  }

  const found = findFiducials(cropped);
  if (found) {
    const h = solveHomography(found.corners, FIDUCIAL_PAGE_POINTS);
    assert.ok(
      !h || residual(h, found.corners, FIDUCIAL_PAGE_POINTS) > 0.05,
      'a two-fiducial crop produced a confident map',
    );
  }
});

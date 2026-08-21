import assert from 'node:assert/strict';
import { before, test } from 'node:test';

import type { Overlays } from '@oramics/template';

import { hasRasteriser, renderSheet } from './fixture.js';
import type { Gray } from './image.js';
import { importSheet } from './index.js';
import { photograph } from './testing.js';

const RASTERISER = hasRasteriser();
const skip = RASTERISER ? false : 'pdftoppm is not installed';

const COLUMNS = 400;

/** A ramp, so up and down are told apart and so is left and right. */
const ramp = (): Float32Array => {
  const out = new Float32Array(COLUMNS);
  for (let i = 0; i < COLUMNS; i++) {
    const t = i / (COLUMNS - 1);
    out[i] = t < 0.1 || t > 0.9 ? Number.NaN : 0.15 + 0.7 * ((t - 0.1) / 0.8);
  }
  return out;
};

const OVERLAYS: Overlays = { PCH: ramp() };

let drawn: Gray;

before(async () => {
  if (RASTERISER) drawn = await renderSheet(200, OVERLAYS);
});

/** Turn a picture by a whole number of quarter turns. */
const turn = (img: Gray, quarters: number): Gray => {
  const q = ((quarters % 4) + 4) % 4;
  if (q === 0) return img;
  const swap = q % 2 === 1;
  const width = swap ? img.height : img.width;
  const height = swap ? img.width : img.height;
  const out = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let sx: number;
      let sy: number;
      if (q === 1) {
        sx = y;
        sy = img.height - 1 - x;
      } else if (q === 2) {
        sx = img.width - 1 - x;
        sy = img.height - 1 - y;
      } else {
        sx = img.width - 1 - y;
        sy = x;
      }
      out[y * width + x] = img.data[sy * img.width + sx]!;
    }
  }
  return { data: out, width, height };
};

// ---------------------------------------------------------------------------

test('a sheet photographed sideways is read the right way up', { skip }, () => {
  /*
   * The failure this exists for. Four identical corner squares register a
   * portrait photograph onto the page's own transpose perfectly happily: the
   * corner fit comes out at zero, every band is sampled across the sheet
   * instead of along it, and the whole thing looks like a reading rather than
   * like a mistake. It took a real workshop sheet to notice, because a test
   * that only ever photographs the page in landscape never asks the question.
   */
  const want = OVERLAYS.PCH as Float32Array;

  for (const quarters of [0, 1, 2, 3]) {
    const rotated = turn(drawn, quarters);
    const result = importSheet(rotated, { laneColumns: COLUMNS });
    assert.ok(result.ok, `${quarters} turns: ${result.ok ? '' : result.message}`);
    if (!result.ok) continue;

    // A scan has the resolution to read the printed bar outright.
    assert.ok(
      result.orientation.explicit,
      `${quarters} turns: orientation was inferred, not read from the printed mark`,
    );

    // The ramp has to come back rising, in the right band, at the right height.
    const got = result.contents.lanes.PCH!;
    for (const at of [0.25, 0.5, 0.75]) {
      const i = Math.round(at * (COLUMNS - 1));
      assert.ok(
        Math.abs(got[i]! - want[i]!) < 0.08,
        `${quarters} turns: at ${at} of the way along, read ${got[i]?.toFixed(2)} not ${want[i]!.toFixed(2)}`,
      );
    }
    // And a band nobody drew in stays empty, which a transposed read never is.
    assert.ok(
      result.contents.coverage.AMP3! < 0.05,
      `${quarters} turns: an untouched band came back ${(result.contents.coverage.AMP3! * 100).toFixed(0)}% covered`,
    );
  }
});

test('a sideways photograph is read the right way up too', { skip }, () => {
  // Rotated and photographed at an angle, which is what a phone actually does.
  const portrait = turn(drawn, 1);
  const scan = photograph(portrait, {
    width: 1500,
    perspective: 0.04,
    rotate: 5,
    vignette: 0.3,
    noise: 0.012,
    blur: 1,
    seed: 21,
  });

  const result = importSheet(scan.image, { laneColumns: COLUMNS });
  assert.ok(result.ok, result.ok ? '' : result.message);
  if (!result.ok) return;

  assert.ok(result.orientation.explicit, 'orientation was inferred, not read');
  // Nothing else was drawn on, and a transposed or misregistered read never
  // leaves the other seven bands empty.
  for (const role of ['AMP1', 'AMP2', 'AMP3', 'AMP4', 'VIB', 'REV', 'TRN']) {
    assert.ok(
      result.contents.coverage[role]! < 0.05,
      `${role} came back ${(result.contents.coverage[role]! * 100).toFixed(0)}% covered`,
    );
  }

  const want = OVERLAYS.PCH as Float32Array;
  const got = result.contents.lanes.PCH!;
  for (const at of [0.2, 0.5, 0.8]) {
    const i = Math.round(at * (COLUMNS - 1));
    assert.ok(
      Math.abs(got[i]! - want[i]!) < 0.05,
      `at ${at} along, read ${got[i]?.toFixed(3)} not ${want[i]!.toFixed(3)}`,
    );
  }
});

test('a sheet printed before the orientation mark still lands the right way up', { skip }, () => {
  /*
   * Sheets are already out there without the bar on them. The QR is a dense
   * block at a known place on every sheet ever printed, so it settles the half
   * turn that shape alone cannot, and those sheets keep working.
   */
  const painted: Gray = { data: Float32Array.from(drawn.data), width: drawn.width, height: drawn.height };
  // Paint out the mark, leaving a sheet exactly as an older build printed it.
  const perMm = drawn.width / 355.6;
  for (let y = Math.round(20 * perMm); y < Math.round(28 * perMm); y++) {
    for (let x = Math.round(6 * perMm); x < Math.round(16 * perMm); x++) {
      painted.data[y * painted.width + x] = 1;
    }
  }

  for (const quarters of [0, 2]) {
    const result = importSheet(turn(painted, quarters), { laneColumns: COLUMNS });
    assert.ok(result.ok, `${quarters} turns: ${result.ok ? '' : result.message}`);
    if (!result.ok) continue;
    assert.equal(result.orientation.explicit, false, 'the mark should be gone');
    assert.ok(
      result.contents.coverage.AMP3! < 0.05,
      `${quarters} turns: an untouched band came back covered, so the page is upside down`,
    );
    assert.ok(result.payload, `${quarters} turns: the QR should still decode`);
  }
});

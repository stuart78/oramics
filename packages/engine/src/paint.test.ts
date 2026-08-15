import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Machine } from './machine.js';
import { mulberry32, paintSlideField, randomRecipe, randomSlideField } from './paint.js';
import { SLIDE_HEIGHT as H, SLIDE_WIDTH as W, Slide } from './slide.js';

const SR = 48_000;

const paintedColumns = (field: Float32Array): number => {
  let n = 0;
  for (let x = 0; x < W; x++) {
    for (let y = 0; y < H; y++) {
      if (field[y * W + x]! >= 0.5) {
        n++;
        break;
      }
    }
  }
  return n;
};

/**
 * Harmonic richness of the edge the spot would ride: energy above the fourth
 * partial as a fraction of the total. This is the quantity the museum caption
 * is describing when it contrasts rounder and spikier shapes.
 */
const brightness = (field: Float32Array): number => {
  const contour = Slide.preblurred(field, W, H).topEdgeContour(512);
  const n = contour.length;
  let low = 0;
  let high = 0;
  for (let h = 1; h < 40; h++) {
    let re = 0;
    let im = 0;
    for (let i = 0; i < n; i++) {
      const a = (2 * Math.PI * h * i) / n;
      re += contour[i]! * Math.cos(a);
      im += contour[i]! * Math.sin(a);
    }
    const mag = Math.hypot(re, im) / n;
    if (h <= 4) low += mag;
    else high += mag;
  }
  return high / (low + high + 1e-9);
};

const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;

/**
 * How much of the edge's shape is carried by its first harmonic.
 *
 * Near 1 the stroke is a sine with a wobble on it. Every generated slide used
 * to land there, because the contour was a harmonic series with a strong
 * fundamental, and four timbres side by side all looked like the same curve.
 */
const fundamentalShare = (field: Float32Array): number => {
  const contour = Slide.preblurred(field, W, H).topEdgeContour(512);
  const n = contour.length;
  const dc = contour.reduce((a, b) => a + b, 0) / n;
  const mags: number[] = [];
  for (let h = 1; h <= 16; h++) {
    let re = 0;
    let im = 0;
    for (let i = 0; i < n; i++) {
      const a = (2 * Math.PI * h * i) / n;
      re += (contour[i]! - dc) * Math.cos(a);
      im += (contour[i]! - dc) * Math.sin(a);
    }
    mags.push(Math.hypot(re, im) / n);
  }
  return mags[0]! / (mags.reduce((a, b) => a + b, 0) + 1e-9);
};

/** Where the edge sits on the glass on average, -1 bottom rail to 1 top. */
const edgeCentre = (field: Float32Array): number => {
  const contour = Slide.preblurred(field, W, H).topEdgeContour(512);
  return contour.reduce((a, b) => a + b, 0) / contour.length;
};

/** Rows of enamel in the thinnest column, as a fraction of the height. */
const thinnestColumn = (field: Float32Array): number => {
  let thinnest = Infinity;
  for (let x = 0; x < W; x++) {
    let rows = 0;
    for (let y = 0; y < H; y++) if (field[y * W + x]! >= 0.5) rows++;
    thinnest = Math.min(thinnest, rows);
  }
  return thinnest / H;
};

// ---------------------------------------------------------------------------

test('a seed reproduces a slide exactly', () => {
  const a = randomSlideField(12345).field;
  const b = randomSlideField(12345).field;
  assert.deepEqual(a, b);
});

test('different seeds give different slides', () => {
  const a = randomSlideField(1).field;
  const b = randomSlideField(2).field;
  let differing = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) differing++;
  assert.ok(differing > a.length * 0.02, `only ${differing} samples differed`);
});

test('spiky recipes really are brighter than round ones', () => {
  // The one claim the control has to honour. Averaged over seeds, because any
  // single random stroke can land anywhere.
  const sample = (roundness: number): number =>
    mean(
      Array.from({ length: 12 }, (_, s) => brightness(randomSlideField(s + 1, { roundness }).field)),
    );

  const spiky = sample(0);
  const round = sample(1);
  assert.ok(
    spiky > round * 1.5,
    `spiky ${spiky.toFixed(3)} should be clearly brighter than round ${round.toFixed(3)}`,
  );
});

test('an unbroken stroke covers every column', () => {
  // Otherwise the scanner loses lock on a slide that was never meant to break.
  const rand = mulberry32(7);
  const recipe = { ...randomRecipe(rand), breakup: 0, ribbons: 1 };
  const field = paintSlideField(recipe, rand);
  assert.equal(paintedColumns(field), W);
});

test('breakup thins the stroke without always punching through', () => {
  const rand = mulberry32(99);
  const base = { ...randomRecipe(rand), breakup: 0, ribbons: 1, thickness: 0.2 };
  const intact = paintSlideField(base, mulberry32(99));
  const broken = paintSlideField({ ...base, breakup: 0.9 }, mulberry32(99));

  const ink = (f: Float32Array): number => f.reduce((a, b) => a + b, 0);
  assert.ok(ink(broken) < ink(intact), 'breakup should remove enamel');
  assert.ok(paintedColumns(broken) > 0, 'breakup erased the whole stroke');
});

test('every generated slide gives the scanner something to lock onto', () => {
  // A recipe that produced silence would be a dud in a workshop.
  for (let seed = 1; seed <= 25; seed++) {
    const { field } = randomSlideField(seed);
    const slide = Slide.preblurred(field, W, H);
    const m = new Machine({ sampleRate: SR });
    m.setSlide(0, slide);
    const lane = (v: number): Float32Array => new Float32Array(64).fill(v);
    m.lanes.pitch.load(lane(0.5), 30);
    m.lanes.amp1.load(lane(1), 30);
    m.bounce(0.5);
    const buf = m.bounce(0.3);

    let rms = 0;
    for (const v of buf) {
      assert.ok(Number.isFinite(v), `seed ${seed} produced a non-finite sample`);
      rms += v * v;
    }
    rms = Math.sqrt(rms / buf.length);
    assert.ok(rms > 1e-4, `seed ${seed} was silent (rms ${rms.toExponential(2)})`);
  }
});

test('random slides land at comparable levels', () => {
  // Four timbres get summed, so a slide an order of magnitude quieter than its
  // neighbours simply vanishes. Breakup was the culprit: a hole through to bare
  // glass drops the spot to the rail and the recovery costs far more than the
  // width of the hole, so three clear columns out of 512 cost seven eighths of
  // the level. Slides ranged over 14x before holes were dropped entirely and
  // thin enamel was kept above the loop's lock threshold.
  //
  // Run over enough seeds to actually catch it. At sixteen this passed while
  // roughly one slide in a hundred was still a dud, which is often enough that
  // somebody in a workshop presses Randomise and gets silence.
  const levels: number[] = [];
  for (let seed = 1; seed <= 64; seed++) {
    const m = new Machine({ sampleRate: SR });
    m.setSlide(0, Slide.preblurred(randomSlideField(seed).field, W, H));
    const lane = (v: number): Float32Array => new Float32Array(64).fill(v);
    m.lanes.pitch.load(lane(0.22), 30);
    m.lanes.amp1.load(lane(1), 30);
    m.bounce(1);
    const buf = m.bounce(0.3);
    let acc = 0;
    for (const v of buf) acc += v * v;
    levels.push(Math.sqrt(acc / buf.length));
  }

  const loudest = Math.max(...levels);
  const quietest = Math.min(...levels);
  assert.ok(
    loudest / quietest < 4,
    `levels span ${(loudest / quietest).toFixed(1)}x: ${levels.map((l) => l.toFixed(3)).join(', ')}`,
  );
});

test('generated strokes are not all the same sine', () => {
  const shares = Array.from({ length: 48 }, (_, s) => fundamentalShare(randomSlideField(s + 1).field));
  const sorted = [...shares].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)]!;

  // Measured at 0.37 median with a third of slides under 0.35, against a
  // generator that used to sit near the top of the range on almost every seed.
  assert.ok(median < 0.55, `median fundamental share ${median.toFixed(2)}, strokes still sine-like`);
  assert.ok(
    shares.filter((f) => f < 0.35).length >= shares.length / 4,
    `only ${shares.filter((f) => f < 0.35).length}/${shares.length} strokes led with something other than the fundamental`,
  );
  // And the other way: some slides should still be simple, or the control has
  // just moved the monoculture somewhere else.
  assert.ok(Math.max(...shares) > 0.6, 'no simple strokes left in the range');
});

test('strokes sit at different heights on the glass', () => {
  const centres = Array.from({ length: 48 }, (_, s) => edgeCentre(randomSlideField(s + 1).field));
  const spread = Math.max(...centres) - Math.min(...centres);
  assert.ok(spread > 0.7, `edge centres only span ${spread.toFixed(2)} of the glass`);
});

test('a stroke is never painted thinner than the servo can hold', () => {
  /*
   * Measured: sweeping thickness against swing and complexity, output level is
   * flat from about a tenth of the height upward and falls off a cliff below
   * it — a quarter of the level at 0.06 and a seventh at 0.04. A thin ribbon
   * gives the loop nothing to fall back into when an overshoot on a steep flank
   * carries the spot past the paint. So the floor holds however thin the recipe
   * asks for, including where weight variation would take it.
   */
  const rand = mulberry32(4);
  const recipe = {
    ...randomRecipe(rand),
    thickness: 0.01,
    thicknessVariation: 1,
    breakup: 0,
    splotches: 0,
    ribbons: 1,
  };
  const thinnest = thinnestColumn(paintSlideField(recipe, rand));
  assert.ok(thinnest >= 0.09, `thinnest column was ${(thinnest * 100).toFixed(1)}% of the glass`);
});

test('splotches add enamel without breaking the stroke', () => {
  const rand = mulberry32(21);
  const base = { ...randomRecipe(rand), breakup: 0, ribbons: 1, splotches: 0 };
  const plain = paintSlideField(base, mulberry32(21));
  const blobbed = paintSlideField({ ...base, splotches: 3 }, mulberry32(21));

  const ink = (f: Float32Array): number => f.reduce((a, b) => a + b, 0);
  assert.ok(ink(blobbed) > ink(plain) * 1.02, 'splotches put no extra enamel on the glass');
  assert.equal(paintedColumns(blobbed), W, 'splotches left a column bare');
});

test('generating a slide is fast enough to hold a button down', () => {
  const t0 = performance.now();
  for (let i = 0; i < 20; i++) randomSlideField(i);
  const each = (performance.now() - t0) / 20;
  assert.ok(each < 25, `generation took ${each.toFixed(1)} ms per slide`);
});

test('the wildness bias controls how eventful results are', () => {
  const count = (wildness: number): { gaps: number; stacked: number } => {
    let gaps = 0;
    let stacked = 0;
    for (let s = 1; s <= 60; s++) {
      const { recipe } = randomSlideField(s, { wildness });
      if (recipe.breakup > 0) gaps++;
      if (recipe.ribbons > 1) stacked++;
    }
    return { gaps, stacked };
  };
  const calm = count(0);
  const wild = count(1);
  assert.equal(calm.gaps, 0, 'wildness 0 should never break the enamel');
  assert.equal(calm.stacked, 0, 'wildness 0 should never stack ribbons');
  assert.ok(wild.gaps > 5, `wildness 1 produced only ${wild.gaps} broken slides`);
  assert.ok(wild.stacked > 5, `wildness 1 produced only ${wild.stacked} stacked slides`);
});

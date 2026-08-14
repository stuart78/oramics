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
  // neighbours simply vanishes. Breakup was the culprit: a wide hole through to
  // bare glass drops the spot to the rail, the DC blocker removes that, and the
  // stroke stops making a tone. Slides ranged over 14x before holes were
  // narrowed and thin enamel was kept above the loop's lock threshold.
  const levels: number[] = [];
  for (let seed = 1; seed <= 16; seed++) {
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

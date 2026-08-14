import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DEFAULT_SCANNER_OPTS, FlyingSpotScanner } from './scanner.js';
import { SLIDE_HEIGHT, SLIDE_WIDTH, Slide } from './slide.js';

const SR = 48_000;

/** Row index for a -1..1 position, row 0 at the top. */
const rowFor = (v: number): number => Math.round(((1 - v) / 2) * (SLIDE_HEIGHT - 1));

/**
 * Paint a horizontal ribbon whose top edge sits at `top` (-1..1), `thickness`
 * of full height, optionally leaving a clear gap between two x fractions.
 */
const ribbon = (
  top: number,
  thickness = 0.2,
  gap?: [from: number, to: number],
): Float32Array => {
  const field = new Float32Array(SLIDE_WIDTH * SLIDE_HEIGHT);
  const r0 = rowFor(top);
  const r1 = Math.min(SLIDE_HEIGHT - 1, r0 + Math.round(thickness * SLIDE_HEIGHT));
  for (let x = 0; x < SLIDE_WIDTH; x++) {
    const t = x / SLIDE_WIDTH;
    if (gap && t >= gap[0] && t < gap[1]) continue;
    for (let y = r0; y <= r1; y++) field[y * SLIDE_WIDTH + x] = 1;
  }
  return field;
};

const slideOf = (field: Float32Array): Slide =>
  Slide.fromField(field, SLIDE_WIDTH, SLIDE_HEIGHT);

/** Run the loop for `cycles` at `hz` and return the last cycle's samples. */
const sweep = (
  slide: Slide,
  hz: number,
  cycles = 40,
  opts = DEFAULT_SCANNER_OPTS,
): Float32Array => {
  const scanner = new FlyingSpotScanner(SR, opts);
  scanner.reset();
  const perCycle = Math.round(SR / hz);
  const out = new Float32Array(perCycle);
  for (let c = 0; c < cycles; c++) {
    for (let i = 0; i < perCycle; i++) {
      const y = scanner.step(slide, hz);
      if (c === cycles - 1) out[i] = y;
    }
  }
  return out;
};

const mean = (b: Float32Array): number => b.reduce((s, v) => s + v, 0) / b.length;
/** Peak-to-peak excursion — how much of the drawn shape the loop actually followed. */
const excursion = (b: Float32Array): number => Math.max(...b) - Math.min(...b);

/** Total absolute sample-to-sample change — a cheap proxy for brightness. */
const roughness = (b: Float32Array): number => {
  let acc = 0;
  for (let i = 1; i < b.length; i++) acc += Math.abs(b[i]! - b[i - 1]!);
  return acc;
};

// ---------------------------------------------------------------------------

test('the spot settles on the top edge of a ribbon', () => {
  for (const top of [0.6, 0.1, -0.4]) {
    const out = sweep(slideOf(ribbon(top)), 110);
    assert.ok(
      Math.abs(mean(out) - top) < 0.12,
      `ribbon top at ${top} but the spot averaged ${mean(out).toFixed(3)}`,
    );
  }
});

test('ribbon thickness does not change the waveform', () => {
  // The loop rides the upper silhouette; everything below it is unreachable, so
  // strokes sharing a top edge sound the same however thick they are. Both are
  // comfortably wider than the spot: below that the blur from the underside
  // reaches the top edge and thickness does start to matter a little, which is
  // also true of the real thing.
  const thin = sweep(slideOf(ribbon(0.3, 0.15)), 110);
  const thick = sweep(slideOf(ribbon(0.3, 0.45)), 110);
  let worst = 0;
  for (let i = 0; i < thin.length; i++) worst = Math.max(worst, Math.abs(thin[i]! - thick[i]!));
  assert.ok(worst < 0.05, `thickness shifted the waveform by ${worst.toFixed(3)}`);
});

test('a blank slide drops the spot to the bottom rail', () => {
  const out = sweep(Slide.blank(), 110);
  assert.ok(mean(out) < -0.9, `expected the rail, got ${mean(out).toFixed(3)}`);
});

test('a gap in the paint makes the spot lose lock and dive', () => {
  const solid = sweep(slideOf(ribbon(0.4, 0.2)), 110);
  const gapped = sweep(slideOf(ribbon(0.4, 0.2, [0.45, 0.6])), 110);
  assert.ok(
    Math.min(...gapped) < Math.min(...solid) - 0.25,
    `gap should produce a dive: solid min ${Math.min(...solid).toFixed(2)}, ` +
      `gapped min ${Math.min(...gapped).toFixed(2)}`,
  );
});

test('recovery from a gap is slew limited, not instant', () => {
  const gapped = sweep(slideOf(ribbon(0.4, 0.2, [0.4, 0.55])), 110);
  const lowest = gapped.indexOf(Math.min(...gapped));
  // Count samples to climb back within 10% of the ribbon top.
  let recovery = 0;
  for (let i = lowest; i < gapped.length; i++, recovery++) {
    if (gapped[i]! > 0.3) break;
  }
  assert.ok(recovery > 4, `climbed back in ${recovery} samples; the loop has inertia`);
});

test('high notes outrun the servo and come out smoother', () => {
  // The signature behaviour: the sweep rate is the note frequency, the loop
  // bandwidth is fixed, so the same slide is duller up high. Compare roughness
  // per sample so the different cycle lengths do not decide the result.
  const bumpy = new Float32Array(SLIDE_WIDTH * SLIDE_HEIGHT);
  for (let x = 0; x < SLIDE_WIDTH; x++) {
    const top = 0.3 + 0.35 * Math.sin((x / SLIDE_WIDTH) * Math.PI * 12);
    const r0 = rowFor(top);
    for (let y = r0; y < Math.min(SLIDE_HEIGHT, r0 + 40); y++) bumpy[y * SLIDE_WIDTH + x] = 1;
  }
  const slide = slideOf(bumpy);

  const low = sweep(slide, 80);
  const high = sweep(slide, 640);
  const lowPerSample = roughness(low) / low.length;
  const highPerSample = roughness(high) / high.length;

  assert.ok(
    excursion(low) > excursion(high) * 1.15,
    `the low note should follow more of the shape: ${excursion(low).toFixed(2)} vs ${excursion(high).toFixed(2)}`,
  );
  assert.ok(
    lowPerSample > highPerSample,
    `low note roughness/sample ${lowPerSample.toFixed(4)} should exceed high ${highPerSample.toFixed(4)}`,
  );
});

test('an underdamped loop rings and a damped one does not', () => {
  const step = new Float32Array(SLIDE_WIDTH * SLIDE_HEIGHT);
  for (let x = 0; x < SLIDE_WIDTH; x++) {
    const top = x < SLIDE_WIDTH / 2 ? -0.3 : 0.5;
    const r0 = rowFor(top);
    for (let y = r0; y < SLIDE_HEIGHT; y++) step[y * SLIDE_WIDTH + x] = 1;
  }
  const slide = slideOf(step);

  const ringy = sweep(slide, 110, 40, { ...DEFAULT_SCANNER_OPTS, damping: 0.2 });
  const damped = sweep(slide, 110, 40, { ...DEFAULT_SCANNER_OPTS, damping: 1.4 });
  assert.ok(
    Math.max(...ringy) > Math.max(...damped) + 0.02,
    `underdamped should overshoot further: ${Math.max(...ringy).toFixed(3)} vs ${Math.max(...damped).toFixed(3)}`,
  );
});

test('the loop carries state across the flyback, so cycles are not identical', () => {
  const slide = slideOf(ribbon(0.5, 0.2, [0.7, 0.85]));
  const scanner = new FlyingSpotScanner(SR, DEFAULT_SCANNER_OPTS);
  const hz = 110;
  const perCycle = Math.round(SR / hz);
  const first = new Float32Array(perCycle);
  const second = new Float32Array(perCycle);
  for (let i = 0; i < perCycle; i++) first[i] = scanner.step(slide, hz);
  for (let i = 0; i < perCycle; i++) second[i] = scanner.step(slide, hz);

  let worst = 0;
  for (let i = 0; i < perCycle; i++) worst = Math.max(worst, Math.abs(first[i]! - second[i]!));
  assert.ok(worst > 1e-6, 'consecutive cycles were bit-identical; the loop has no memory');
});

test('a scan window selects one ribbon from a slide carrying several', () => {
  // Two ribbons, as on Oram's slides. The window decides which one plays.
  const field = new Float32Array(SLIDE_WIDTH * SLIDE_HEIGHT);
  for (const top of [0.75, 0.0]) {
    const r0 = rowFor(top);
    for (let x = 0; x < SLIDE_WIDTH; x++) {
      for (let y = r0; y < r0 + 22; y++) field[y * SLIDE_WIDTH + x] = 1;
    }
  }
  const slide = slideOf(field);

  /**
   * The window offsets and scales the slide across a fixed deflection range —
   * moving the glass, not restricting the spot — so the selected ribbon plays
   * at full scale. Map the output back into slide coordinates to check which
   * ribbon was found.
   */
  const readSlidePosition = (low: number, high: number): number => {
    const scanner = new FlyingSpotScanner(SR, DEFAULT_SCANNER_OPTS);
    scanner.reset();
    const perCycle = Math.round(SR / 110);
    let last = 0;
    for (let c = 0; c < 60; c++) {
      for (let i = 0; i < perCycle; i++) last = scanner.step(slide, 110, low, high);
    }
    return low + ((last + 1) / 2) * (high - low);
  };

  const upper = readSlidePosition(0.4, 1);
  const lower = readSlidePosition(-0.6, 0.35);
  assert.ok(
    Math.abs(upper - 0.75) < 0.12,
    `upper window should land on the ribbon at 0.75, got ${upper.toFixed(2)}`,
  );
  assert.ok(
    Math.abs(lower - 0.0) < 0.12,
    `lower window should land on the ribbon at 0.0, got ${lower.toFixed(2)}`,
  );
});

test('the loop stays bounded with an absurd natural frequency', () => {
  // loopHz above the stability limit must degrade to "very fast", not blow up.
  const out = sweep(slideOf(ribbon(0.2)), 220, 30, {
    ...DEFAULT_SCANNER_OPTS,
    loopHz: 500_000,
    damping: 0.1,
  });
  for (const v of out) {
    assert.ok(Number.isFinite(v), 'scanner produced a non-finite sample');
    assert.ok(Math.abs(v) <= 1.0001, `scanner left the rails at ${v}`);
  }
});

test('the top-edge contour matches where the spot settles', () => {
  // The wavetable bypass has to describe the same slide as the servo path, or
  // the fidelity toggle is comparing two unrelated sounds.
  const slide = slideOf(ribbon(0.45, 0.25));
  const contour = slide.topEdgeContour(256);
  const mid = contour[128]!;
  assert.ok(Math.abs(mid - 0.45) < 0.06, `top edge traced at ${mid.toFixed(3)}, expected 0.45`);

  const settled = mean(sweep(slide, 110));
  assert.ok(
    Math.abs(settled - mid) < 0.12,
    `servo settled at ${settled.toFixed(3)} but the contour says ${mid.toFixed(3)}`,
  );
});

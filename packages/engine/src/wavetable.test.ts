import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Machine } from './machine.js';
import { Slide } from './slide.js';
import { TABLE_SIZE, Wavetable } from './wavetable.js';

const SR = 48_000;

const sineContour = (harmonic = 1, size = TABLE_SIZE): Float32Array => {
  const c = new Float32Array(size);
  for (let i = 0; i < size; i++) c[i] = Math.sin((2 * Math.PI * harmonic * i) / size);
  return c;
};

/** Worst absolute difference between a level and a reference cycle. */
const worstError = (level: Float32Array, reference: (phase: number) => number): number => {
  let worst = 0;
  for (let i = 0; i < level.length; i++) {
    worst = Math.max(worst, Math.abs(level[i]! - reference(i / level.length)));
  }
  return worst;
};

const rms = (b: Float32Array): number => {
  let acc = 0;
  for (const v of b) acc += v * v;
  return Math.sqrt(acc / b.length);
};

// The mip levels are built by analysing the table into harmonics and
// resynthesising with fewer. Level 0 is the raw table and skips the transform
// entirely, so without these the DFT is essentially untested.

test('the analysis and resynthesis round-trip preserves a sine', () => {
  const wt = Wavetable.fromContour(sineContour(1), { spotSize: 0, maxSlope: 1e9, overshoot: 0 });
  // Level 1 keeps 512 partials — far more than a sine needs, so it should come
  // back all but unchanged.
  const err = worstError(wt.levels[1]!, (p) => Math.sin(2 * Math.PI * p));
  assert.ok(err < 0.02, `sine round-tripped with ${err.toFixed(4)} error`);
});

test('a harmonic survives resynthesis at the right frequency and phase', () => {
  const wt = Wavetable.fromContour(sineContour(3), { spotSize: 0, maxSlope: 1e9, overshoot: 0 });
  const err = worstError(wt.levels[1]!, (p) => Math.sin(2 * Math.PI * 3 * p));
  assert.ok(err < 0.02, `third harmonic round-tripped with ${err.toFixed(4)} error`);
});

/** Magnitude of one harmonic, by direct projection. */
const harmonicMagnitude = (b: Float32Array, h: number): number => {
  let re = 0;
  let im = 0;
  for (let i = 0; i < b.length; i++) {
    const a = (2 * Math.PI * h * i) / b.length;
    re += b[i]! * Math.cos(a);
    im += b[i]! * Math.sin(a);
  }
  return (2 * Math.hypot(re, im)) / b.length;
};

test('each mip level drops the harmonics above its limit', () => {
  // Measured on harmonic content, not on a derivative. Truncating the Fourier
  // series of a square wave produces Gibbs ringing, and the ripple at 512
  // harmonics is fine enough that a 2048-point grid undersamples it — so path
  // length is not monotonic across levels even though the spectrum is.
  const square = new Float32Array(TABLE_SIZE);
  for (let i = 0; i < TABLE_SIZE; i++) square[i] = i < TABLE_SIZE / 2 ? 1 : -1;
  const wt = Wavetable.fromContour(square, { spotSize: 0, maxSlope: 1e9, overshoot: 0 });

  for (let k = 1; k < wt.levels.length; k++) {
    const limit = Math.floor(TABLE_SIZE / 2 / Math.pow(2, k));
    const level = wt.levels[k]!;

    // A surviving odd harmonic well inside the limit.
    const inside = Math.max(1, (Math.floor(limit / 2) | 1) - 2);
    assert.ok(
      harmonicMagnitude(level, inside) > 0.001,
      `level ${k} lost harmonic ${inside}, which is inside its ${limit} limit`,
    );

    // The first odd harmonic past the limit must be gone.
    const outside = (limit + 1) | 1;
    if (outside < TABLE_SIZE / 2 - 1) {
      assert.ok(
        harmonicMagnitude(level, outside) < 1e-4,
        `level ${k} kept harmonic ${outside}, past its ${limit} limit`,
      );
    }
  }
});

test('band limiting removes energy rather than adding it', () => {
  // A resynthesis bug that scaled wrongly would show up as a level gaining
  // amplitude as harmonics are stripped.
  const square = new Float32Array(TABLE_SIZE);
  for (let i = 0; i < TABLE_SIZE; i++) square[i] = i < TABLE_SIZE / 2 ? 1 : -1;
  const wt = Wavetable.fromContour(square, { spotSize: 0, maxSlope: 1e9, overshoot: 0 });
  const base = rms(wt.levels[1]!);
  for (let k = 2; k < wt.levels.length; k++) {
    assert.ok(
      rms(wt.levels[k]!) <= base * 1.05,
      `level ${k} rms ${rms(wt.levels[k]!).toFixed(3)} exceeds level 1's ${base.toFixed(3)}`,
    );
  }
});

test('installing a slide stays cheap enough for the audio thread', () => {
  // setSlide runs on the audio thread every time the brush moves. It used to
  // derive the wavetable bypass eagerly, which cost 57 ms — twenty render
  // quanta — and audibly halted playback while painting. The bound here is
  // deliberately loose; the regression it guards against was 20x over it.
  const QUANTUM_MS = (128 / SR) * 1000;
  const m = new Machine({ sampleRate: SR });
  const slide = Slide.sine();

  m.setSlide(0, slide); // warm up
  const t0 = performance.now();
  for (let i = 0; i < 20; i++) m.setSlide(0, slide);
  const each = (performance.now() - t0) / 20;

  assert.ok(
    each < QUANTUM_MS,
    `setSlide took ${each.toFixed(2)} ms, over the ${QUANTUM_MS.toFixed(2)} ms render quantum`,
  );
});

test('the bypass table is built on demand and then reused', () => {
  // Lazy, but it must still arrive — and only once.
  const m = new Machine({ sampleRate: SR, fidelity: { servoScanner: false } });
  m.setSlide(0, Slide.sine());
  const lane = (v: number): Float32Array => new Float32Array(64).fill(v);
  m.lanes.pitch.load(lane(0.5), 30);
  m.lanes.amp1.load(lane(1), 30);

  const first = performance.now();
  m.bounce(0.05);
  const firstMs = performance.now() - first;

  const second = performance.now();
  m.bounce(0.05);
  const secondMs = performance.now() - second;

  assert.ok(rms(m.bounce(0.2)) > 0.001, 'the bypass path produced no sound');
  assert.ok(
    secondMs < firstMs || firstMs < 5,
    `the table looks rebuilt each block: ${firstMs.toFixed(2)} then ${secondMs.toFixed(2)} ms`,
  );
});

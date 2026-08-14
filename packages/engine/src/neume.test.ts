import assert from 'node:assert/strict';
import { test } from 'node:test';

import { FAITHFUL, Machine, PITCH_LANE_MAX_HZ } from './machine.js';
import {
  DEFAULT_RELAYS,
  NEUME_DIGITS,
  NEUME_MAX_HZ,
  NEUME_WEIGHTS,
  RelayBank,
  decodeNeume,
  encodeNeume,
} from './neume.js';

const SR = 48_000;

const constant = (v: number, n = 64): Float32Array => new Float32Array(n).fill(v);

// ---------------------------------------------------------------------------
// The code
// ---------------------------------------------------------------------------

test('the tracks are weighted 1-2-4-2, not 8-4-2-1', () => {
  // Wrench: "The track on the lower edge of the film does nought or one; the
  // next one up does nought and two; the next does nought and four; the
  // top-most track does nought and two again: hence, weighted binary."
  assert.deepEqual([...NEUME_WEIGHTS], [1, 2, 4, 2]);
  assert.equal(
    NEUME_WEIGHTS.reduce((a, b) => a + b, 0),
    9,
    'the four tracks must sum to 9, one decimal digit',
  );
});

test('every digit 0-9 is paintable', () => {
  for (let digit = 0; digit <= 9; digit++) {
    const bits = encodeNeume(digit, 1);
    assert.equal(decodeNeume(bits), digit, `digit ${digit} did not round-trip`);
  }
});

test('the code is the frequency in Hertz, across all four decades', () => {
  for (const hz of [0, 1, 7, 55, 110, 261, 440, 999, 1000, 4321, 9999]) {
    assert.equal(decodeNeume(encodeNeume(hz)), hz, `${hz} Hz did not round-trip`);
  }
});

test('the strips reach 9999 Hz and clamp rather than wrap', () => {
  assert.equal(NEUME_MAX_HZ, 9999);
  assert.equal(NEUME_DIGITS, 4);
  assert.equal(decodeNeume(encodeNeume(12345)), 9999);
  assert.equal(decodeNeume(encodeNeume(-40)), 0);
});

test('a digit can be painted more than one way and still read the same', () => {
  // 4 is the single 4 track, or both 2s. The machine cannot tell them apart.
  const viaFour = [[false, false, true, false]];
  const viaTwoTwos = [[false, true, false, true]];
  assert.equal(decodeNeume(viaFour), 4);
  assert.equal(decodeNeume(viaTwoTwos), 4);
});

// ---------------------------------------------------------------------------
// The relays
// ---------------------------------------------------------------------------

const settle = (bank: RelayBank, seconds: number): number => {
  let hz = 0;
  for (let i = 0; i < seconds * SR; i++) hz = bank.step();
  return hz;
};

test('the relays arrive at the frequency they were aimed at', () => {
  const bank = new RelayBank(SR);
  bank.setTargetHz(440);
  assert.equal(settle(bank, 0.2), 440);
});

test('a decimal carry sweeps through frequencies nobody painted', () => {
  // 199 -> 200 flips eight tracks. They are mechanical and do not move
  // together, so for a few milliseconds the resistor bank spells something else.
  const bank = new RelayBank(SR);
  bank.setTargetHz(199);
  settle(bank, 0.2);

  bank.setTargetHz(200);
  const seen = new Set<number>();
  for (let i = 0; i < 0.1 * SR; i++) seen.add(bank.step());

  seen.delete(199);
  seen.delete(200);
  assert.ok(seen.size > 0, 'the carry was clean; the relays moved in lockstep');
  assert.equal(settle(bank, 0.2), 200, 'the bank did not settle on the target');
});

test('a change within one digit does not glitch', () => {
  // 440 -> 441 flips only the units track that carries the 1.
  const bank = new RelayBank(SR);
  bank.setTargetHz(440);
  settle(bank, 0.2);

  bank.setTargetHz(441);
  const seen = new Set<number>();
  for (let i = 0; i < 0.1 * SR; i++) seen.add(bank.step());
  seen.delete(440);
  seen.delete(441);
  assert.equal(seen.size, 0, `single-track change produced ${[...seen]}`);
});

test('the relays take milliseconds, not samples', () => {
  const bank = new RelayBank(SR, DEFAULT_RELAYS);
  bank.setTargetHz(880);
  let samples = 0;
  while (bank.settling && samples < SR) {
    bank.step();
    samples++;
  }
  const ms = (samples / SR) * 1000;
  assert.ok(ms > 2 && ms < 60, `settled in ${ms.toFixed(1)} ms, expected mechanical timescales`);
});

test('a given transition glitches the same way every time', () => {
  // Per-relay timing is fixed, not random, so the machine has a consistent
  // character rather than a different stumble on each run.
  const run = (): number[] => {
    const bank = new RelayBank(SR);
    bank.setTargetHz(199);
    settle(bank, 0.2);
    bank.setTargetHz(200);
    return Array.from({ length: 2000 }, () => bank.step());
  };
  assert.deepEqual(run(), run());
});

// ---------------------------------------------------------------------------
// The scale
// ---------------------------------------------------------------------------

const pitchAt = (laneValue: number, fidelity = {}): number => {
  const m = new Machine({ sampleRate: SR, fidelity: { relayLag: false, ...fidelity } });
  m.lanes.pitch.load(constant(laneValue), 30);
  m.lanes.amp1.load(constant(1), 30);
  m.bounce(0.02);
  return m.meters.hz;
};

test('the pitch lane is linear in Hertz', () => {
  // Height maps straight onto frequency, because the painted code is a decimal
  // number of cycles per second.
  assert.equal(pitchAt(0), 0);
  assert.equal(pitchAt(0.5), Math.round(PITCH_LANE_MAX_HZ * 0.5));
  assert.equal(pitchAt(1), PITCH_LANE_MAX_HZ);

  // Halfway up is half the frequency, which is emphatically not an octave.
  const top = pitchAt(1);
  const mid = pitchAt(0.5);
  assert.ok(Math.abs(mid / top - 0.5) < 1e-6);
});

test('octaves are unevenly spaced on the linear lane', () => {
  // The thing that makes drawing a tune on this feel wrong, correctly.
  const heightOf = (hz: number): number => hz / PITCH_LANE_MAX_HZ;
  const oct1 = heightOf(220) - heightOf(110);
  const oct2 = heightOf(440) - heightOf(220);
  assert.ok(
    Math.abs(oct2 / oct1 - 2) < 1e-9,
    'each octave should take twice the height of the one below it',
  );
});

test('the logarithmic scale is available but is not the default', () => {
  assert.equal(FAITHFUL.linearPitchScale, true);

  const log = pitchAt(0, { linearPitchScale: false });
  assert.equal(log, 55, 'the log fallback should start at A1');
});

test('one Hertz is coarse low down and fine up high', () => {
  // Uniform in Hz means wildly non-uniform in cents: this is why bass lines on
  // the machine step audibly and high ones do not.
  const cents = (hz: number): number => 1200 * Math.log2((hz + 1) / hz);
  assert.ok(cents(55) > 28, `1 Hz at 55 Hz is ${cents(55).toFixed(1)} cents`);
  assert.ok(cents(880) < 3, `1 Hz at 880 Hz is ${cents(880).toFixed(1)} cents`);
});

test('relay lag is audible on a carry and off when disabled', () => {
  const sweep = (relayLag: boolean): Set<number> => {
    const m = new Machine({ sampleRate: SR, fidelity: { relayLag } });
    const lane = new Float32Array(64);
    // Step from 199 Hz to 200 Hz halfway along.
    lane.fill(199 / PITCH_LANE_MAX_HZ, 0, 32);
    lane.fill(200 / PITCH_LANE_MAX_HZ, 32);
    m.lanes.pitch.load(lane, 1);
    m.lanes.amp1.load(constant(1), 1);
    // `meters.hz` reports the last sample of a block, so the block has to be
    // shorter than the glitch — a relay carry lasts about ten milliseconds.
    const seen = new Set<number>();
    for (let i = 0; i < 1000; i++) {
      m.bounce(0.001);
      seen.add(m.meters.hz);
    }
    return seen;
  };

  const withLag = sweep(true);
  const without = sweep(false);
  assert.ok(
    withLag.size > without.size,
    `lag should introduce intermediate frequencies: ${[...withLag]} vs ${[...without]}`,
  );
});

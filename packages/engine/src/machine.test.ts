import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ControlLane } from './lane.js';
import { Machine, PITCH_RANGE, TIMBRE_COUNT } from './machine.js';
import { Slide } from './slide.js';
import { DEFAULT_VACTROL, DirectGain, Vactrol } from './vactrol.js';
import { TABLE_SIZE, Wavetable } from './wavetable.js';

const SR = 48_000;

/** A lane holding one value for its whole length. */
const constant = (v: number, n = 128): Float32Array => new Float32Array(n).fill(v);

const loadConstant = (lane: ControlLane, v: number, durationS = 30): void => {
  lane.load(constant(v), durationS);
};

/** Frequency by counting rising zero crossings. */
const measureHz = (buf: Float32Array, sampleRate: number): number => {
  let crossings = 0;
  let first = -1;
  let last = -1;
  for (let i = 1; i < buf.length; i++) {
    if (buf[i - 1]! < 0 && buf[i]! >= 0) {
      if (first < 0) first = i;
      last = i;
      crossings++;
    }
  }
  if (crossings < 2) return 0;
  return ((crossings - 1) * sampleRate) / (last - first);
};

const peak = (buf: Float32Array): number => {
  let m = 0;
  for (const v of buf) m = Math.max(m, Math.abs(v));
  return m;
};

const openVoice = (m: Machine, timbres = 1): void => {
  loadConstant(m.lanes.pitch, 0.5);
  for (let i = 1; i <= timbres; i++) {
    loadConstant(m.lanes[`amp${i as 1 | 2 | 3 | 4}`], 1);
  }
};

// ---------------------------------------------------------------------------
// Lanes
// ---------------------------------------------------------------------------

test('a lane interpolates between its samples', () => {
  const lane = new ControlLane();
  lane.load(Float32Array.from([0, 1]), 1);
  lane.position = 0.5;
  assert.ok(Math.abs(lane.read() - 0.5) < 1e-6);
});

test('an undrawn stretch rests or holds, depending on the lane', () => {
  // Blank means "nothing drawn here", not "drawn at zero" — a scanned sheet is
  // mostly blank paper.
  const values = Float32Array.from([1, 1, Number.NaN, Number.NaN, 0.25, 0.25]);

  const resting = new ControlLane();
  resting.defaultValue = 0;
  resting.load(values, 6);
  resting.position = 2.5;
  assert.equal(resting.read(), 0, 'an amplitude lane should fall silent in a gap');

  const holding = new ControlLane();
  holding.gapBehaviour = 'hold';
  holding.load(values, 6);
  holding.position = 0.5;
  holding.read(); // pick up the drawn value
  holding.position = 2.5;
  assert.equal(holding.read(), 1, 'the pitch relays latch, so the gap should sustain');
});

test('a gap is not bridged by interpolation', () => {
  // Ramping into and out of a blank would invent a line nobody drew.
  const lane = new ControlLane();
  lane.load(Float32Array.from([1, Number.NaN, 0]), 3);
  lane.defaultValue = 0.5;
  lane.position = 1.5; // squarely inside the gap
  assert.equal(lane.read(), 0.5);
});

test('a fully blank lane is silent rather than NaN', () => {
  const m = new Machine({ sampleRate: SR });
  m.lanes.amp1.load(new Float32Array(64).fill(Number.NaN), 30);
  loadConstant(m.lanes.pitch, 0.5);
  const buf = m.bounce(0.2);
  for (const v of buf) assert.ok(Number.isFinite(v), 'blank lane produced a non-finite sample');
  assert.equal(peak(buf), 0, 'nothing drawn should mean nothing heard');
});

test('an unloaded lane returns its default and never NaN', () => {
  const lane = new ControlLane();
  lane.defaultValue = 0.5;
  assert.equal(lane.read(), 0.5);
  lane.advance(1 / SR);
  assert.equal(lane.read(), 0.5);
});

test('a looping lane wraps in both directions', () => {
  const lane = new ControlLane();
  lane.load(constant(1), 2);
  lane.position = 1.5;
  lane.speed = 1;
  lane.advance(1);
  assert.ok(lane.position >= 0 && lane.position < 2, `wrapped to ${lane.position}`);

  lane.position = 0.1;
  lane.speed = -1;
  lane.advance(1);
  assert.ok(lane.position >= 0 && lane.position < 2, `reverse wrapped to ${lane.position}`);
});

test('lanes can run at independent speeds', () => {
  const m = new Machine({ sampleRate: SR });
  openVoice(m);
  m.setGlobalSpeed(1);
  m.lanes.amp1.speed = 2;
  m.render(new Float32Array(SR), SR);
  assert.ok(
    Math.abs(m.lanes.amp1.position - m.lanes.pitch.position * 2) < 1e-3,
    'the faster lane should be exactly twice as far along',
  );
});

test('rejects an empty or zero-length sheet rather than producing silence', () => {
  const lane = new ControlLane();
  assert.throws(() => lane.load(new Float32Array(0), 30), /empty/);
  assert.throws(() => lane.load(constant(1), 0), /bad duration/);
});

// ---------------------------------------------------------------------------
// Optical amplitude
// ---------------------------------------------------------------------------

test('the vactrol lags on attack instead of opening instantly', () => {
  const v = new Vactrol(SR);
  // One sample of full drive must not produce full gain.
  assert.ok(v.process(1) < 0.01, 'optical control cannot open in one sample');

  let samples = 1;
  while (v.process(1) < 0.5 && samples < SR) samples++;
  const ms = (samples / SR) * 1000;
  assert.ok(ms > 3 && ms < 80, `-6 dB reached in ${ms.toFixed(1)} ms, expected tens of ms`);
});

test('the vactrol releases far slower than it attacks', () => {
  // Compare the *same* gain span in each direction. Timing "reaches -6 dB"
  // against "falls below -6 dB" measures the log taper, not the time
  // constants, and the taper is steep near the top of the range.
  const LOW = 0.01; // -40 dB
  const HIGH = 0.5; // -6 dB
  const v = new Vactrol(SR);

  let up = 0;
  while (v.process(1) < LOW && up < SR) up++;
  let attack = 0;
  while (v.process(1) < HIGH && attack < SR) attack++;

  for (let i = 0; i < SR; i++) v.process(1); // settle at full
  while (v.process(0) > HIGH) {
    /* fall into the measured window */
  }
  let release = 0;
  while (v.process(0) > LOW && release < SR * 10) release++;

  assert.ok(
    release > attack * 3,
    `-40 to -6 dB took ${attack} samples up but only ${release} down; ` +
      `the cell should recover much more slowly than it responds`,
  );
});

test('the direct gain bypass is instantaneous', () => {
  const d = new DirectGain();
  assert.equal(d.process(1), 1);
  assert.equal(d.process(0), 0);
});

test('the vactrol spans its full range and reaches true silence', () => {
  const v = new Vactrol(SR, DEFAULT_VACTROL);
  for (let i = 0; i < SR; i++) v.process(1);
  assert.ok(v.peek() > 0.99, `full drive should reach unity, got ${v.peek()}`);
  for (let i = 0; i < SR * 4; i++) v.process(0);
  assert.equal(v.peek(), 0, 'zero drive must reach digital silence, not a floor');
});

// ---------------------------------------------------------------------------
// Drawn wavetables
// ---------------------------------------------------------------------------

test('a drawn sine survives the scanner recognisably', () => {
  const contour = new Float32Array(512);
  for (let i = 0; i < 512; i++) contour[i] = Math.sin((2 * Math.PI * i) / 512);
  const wt = Wavetable.fromContour(contour);

  let worst = 0;
  for (let i = 0; i < 256; i++) {
    const phase = i / 256;
    worst = Math.max(worst, Math.abs(wt.sample(phase, 220, SR) - Math.sin(2 * Math.PI * phase)));
  }
  assert.ok(worst < 0.2, `scanner distorted a sine by ${worst.toFixed(3)}`);
});

test('the scanner cannot follow a vertical edge', () => {
  // A drawn square wave: the real machine rounds and overshoots the corners.
  const contour = new Float32Array(TABLE_SIZE);
  for (let i = 0; i < TABLE_SIZE; i++) contour[i] = i < TABLE_SIZE / 2 ? 1 : -1;
  const wt = Wavetable.fromContour(contour);
  const raw = wt.levels[0]!;

  let maxStep = 0;
  for (let i = 1; i < raw.length; i++) maxStep = Math.max(maxStep, Math.abs(raw[i]! - raw[i - 1]!));
  assert.ok(maxStep < 2, `edge passed through at full slope (${maxStep}); slew did nothing`);
  assert.ok(maxStep > 0, 'the edge vanished entirely');
});

test('high notes select a band-limited mip level', () => {
  const contour = new Float32Array(TABLE_SIZE);
  for (let i = 0; i < TABLE_SIZE; i++) contour[i] = i < TABLE_SIZE / 2 ? 1 : -1;
  const wt = Wavetable.fromContour(contour);
  assert.ok(wt.levels.length > 1, 'no mip pyramid was built');

  const harmonicsAt = (hz: number): number => {
    // Reconstruct which level sample() would pick.
    const maxHarmonic = SR / 2 / hz;
    return Math.max(
      0,
      Math.min(wt.levels.length - 1, Math.floor(Math.log2(TABLE_SIZE / 2 / maxHarmonic))),
    );
  };
  assert.ok(
    harmonicsAt(1760) > harmonicsAt(110),
    'a high note must fall back to a more heavily filtered table',
  );
});

// ---------------------------------------------------------------------------
// The voice
// ---------------------------------------------------------------------------

test('an open voice makes sound and a closed one makes none', () => {
  const m = new Machine({ sampleRate: SR });
  const silence = m.bounce(0.2);
  assert.equal(peak(silence), 0, 'no amplitude sheet loaded should mean silence');

  openVoice(m);
  m.reset();
  assert.ok(peak(m.bounce(0.5)) > 0.05, 'an open amplitude lane should produce audio');
});

test('the render never emits NaN or leaves the rails', () => {
  const m = new Machine({ sampleRate: SR });
  openVoice(m, TIMBRE_COUNT);
  loadConstant(m.lanes.vibrato, 1);
  const buf = m.bounce(0.5);
  for (const v of buf) {
    assert.ok(Number.isFinite(v), 'non-finite sample');
    assert.ok(Math.abs(v) <= 1.5, `sample ${v} well outside the rails`);
  }
});

test('pitch lands on whole Hertz when the machine is being faithful', () => {
  for (const v of [0.13, 0.5, 0.77, 0.91]) {
    const m = new Machine({ sampleRate: SR });
    openVoice(m);
    loadConstant(m.lanes.pitch, v);
    m.bounce(0.05);
    assert.equal(m.meters.hz, Math.round(m.meters.hz), `${m.meters.hz} Hz is not an integer`);
  }
});

test('turning off integer-Hz gives back the fractional frequencies', () => {
  // Relay lag has to be off to see this: the relay bank spells a whole number
  // of Hertz by construction, so while it is engaged it quantises the pitch no
  // matter what this flag says. The relays *are* the quantiser.
  const m = new Machine({
    sampleRate: SR,
    fidelity: { integerHzPitch: false, relayLag: false },
  });
  openVoice(m);
  loadConstant(m.lanes.pitch, 0.37);
  m.bounce(0.05);
  assert.notEqual(m.meters.hz, Math.round(m.meters.hz));
});

test('the relay bank quantises pitch even with integer-Hz off', () => {
  const m = new Machine({
    sampleRate: SR,
    fidelity: { integerHzPitch: false, relayLag: true },
  });
  openVoice(m);
  loadConstant(m.lanes.pitch, 0.37);
  m.bounce(0.2);
  assert.equal(m.meters.hz, Math.round(m.meters.hz));
});

test('the rendered audio really is at the frequency the meter claims', () => {
  const m = new Machine({ sampleRate: SR });
  openVoice(m);
  loadConstant(m.lanes.pitch, 0.5);
  m.bounce(0.5); // let the optical attenuator open first
  const buf = m.bounce(1);
  const measured = measureHz(buf, SR);
  assert.ok(
    Math.abs(measured - m.meters.hz) / m.meters.hz < 0.02,
    `meter says ${m.meters.hz} Hz, audio measures ${measured.toFixed(1)} Hz`,
  );
});

test('the log fallback still spans A1 to A5', () => {
  // Not the default any more — the machine's own scale is linear in Hz — but
  // the musically legible option has to keep working.
  const m = new Machine({
    sampleRate: SR,
    fidelity: { integerHzPitch: false, linearPitchScale: false, relayLag: false },
  });
  openVoice(m);

  loadConstant(m.lanes.pitch, 0);
  m.bounce(0.02);
  assert.ok(Math.abs(m.meters.hz - PITCH_RANGE.minHz) < 0.01, `bottom rail gave ${m.meters.hz}`);

  loadConstant(m.lanes.pitch, 1);
  m.bounce(0.02);
  assert.ok(Math.abs(m.meters.hz - PITCH_RANGE.maxHz) < 0.01, `top rail gave ${m.meters.hz}`);
});

test('vibrato bends pitch either side of the centre line', () => {
  const read = (vib: number): number => {
    const m = new Machine({
      sampleRate: SR,
      fidelity: { integerHzPitch: false },
      vibratoDepthCents: 100,
    });
    openVoice(m);
    loadConstant(m.lanes.pitch, 0.5);
    loadConstant(m.lanes.vibrato, vib);
    m.bounce(0.02);
    return m.meters.hz;
  };
  const centre = read(0.5);
  assert.ok(read(1) > centre * 1.05, 'the top rail should bend up a semitone');
  assert.ok(read(0) < centre * 0.95, 'the bottom rail should bend down a semitone');
});

test('a bounce is deterministic', () => {
  const make = (): Machine => {
    const m = new Machine({ sampleRate: SR });
    openVoice(m, 2);
    return m;
  };
  assert.deepEqual(make().bounce(0.1), make().bounce(0.1));
});

test('block size does not change the output', () => {
  // The worklet renders in 128s and the offline bounce is free to use anything;
  // they must agree sample for sample or bounces will not match what was heard.
  const make = (): Machine => {
    const m = new Machine({ sampleRate: SR });
    openVoice(m, 2);
    return m;
  };
  const a = make().bounce(0.1, 128);
  const b = make().bounce(0.1, 977);
  let worst = 0;
  for (let i = 0; i < a.length; i++) worst = Math.max(worst, Math.abs(a[i]! - b[i]!));
  assert.ok(worst < 1e-9, `block size changed the render by ${worst}`);
});

test('an empty slide carrier is silent, not a full-scale DC offset', () => {
  // The scanner parks hard against a rail when there is nothing to track. That
  // is a deflection voltage, not a signal, and the machine was AC-coupled.
  const m = new Machine({ sampleRate: SR });
  for (let i = 0; i < TIMBRE_COUNT; i++) m.setSlide(i, Slide.blank());
  openVoice(m, TIMBRE_COUNT);
  m.bounce(0.4); // let the DC blocker settle after the initial step
  assert.ok(peak(m.bounce(0.3)) < 0.01, 'a blank slide should read as silence');
});

test('the servo scanner and the wavetable bypass describe the same slide', () => {
  // Both paths must track the same pitch — the toggle changes character, not
  // the note. Compare at a low frequency, where the loop keeps up.
  const slide = Slide.sine();
  const render = (servo: boolean): Float32Array => {
    const m = new Machine({ sampleRate: SR, fidelity: { servoScanner: servo } });
    m.setSlide(0, slide);
    openVoice(m);
    loadConstant(m.lanes.pitch, 0.25);
    m.bounce(0.6);
    return m.bounce(1);
  };
  const a = measureHz(render(true), SR);
  const b = measureHz(render(false), SR);
  assert.ok(a > 0 && b > 0, `one path produced no tone: servo ${a}, table ${b}`);
  assert.ok(
    Math.abs(a - b) / b < 0.05,
    `servo ${a.toFixed(1)} Hz and wavetable ${b.toFixed(1)} Hz should agree on pitch`,
  );
});

test('only the servo path makes timbre depend on pitch', () => {
  // The wavetable replays the same cycle at any frequency. The servo has a
  // fixed bandwidth, so the shape it manages to trace changes with the note —
  // the thing a table fundamentally cannot do.
  //
  // The slide needs detail finer than the fundamental for this to show: a plain
  // sine at 800 Hz is still well inside a 2600 Hz loop, and tracking it
  // faithfully is the correct answer. A stroke with a seventh-harmonic wiggle
  // demands ~6 kHz up high, which the loop cannot follow.
  const detailed = new Float32Array(512);
  for (let i = 0; i < 512; i++) {
    const t = i / 512;
    detailed[i] = 0.62 * Math.sin(2 * Math.PI * t) + 0.34 * Math.sin(2 * Math.PI * 7 * t);
  }
  const slide = Slide.fromContour(detailed);
  /**
   * Path length per cycle, normalised by amplitude. A pure sine traces 4A per
   * cycle whatever its frequency, so this lands near 1 for a sine and climbs
   * with harmonic content — and, unlike peak amplitude or a raw derivative, it
   * does not move just because the note changed.
   */
  const shapeAt = (servo: boolean, laneValue: number): number => {
    const m = new Machine({ sampleRate: SR, fidelity: { servoScanner: servo } });
    m.setSlide(0, slide);
    openVoice(m);
    loadConstant(m.lanes.pitch, laneValue);
    m.bounce(0.6);
    const buf = m.bounce(0.3);

    let pathLength = 0;
    for (let i = 1; i < buf.length; i++) pathLength += Math.abs(buf[i]! - buf[i - 1]!);
    const cycles = (buf.length * m.meters.hz) / SR;
    return pathLength / cycles / (4 * peak(buf));
  };

  const tableLow = shapeAt(false, 0.1);
  const tableHigh = shapeAt(false, 0.95);
  const servoLow = shapeAt(true, 0.1);
  const servoHigh = shapeAt(true, 0.95);

  assert.ok(
    Math.abs(tableHigh - tableLow) / tableLow < 0.2,
    `the wavetable should be pitch-invariant: ${tableLow.toFixed(3)} vs ${tableHigh.toFixed(3)}`,
  );
  assert.ok(
    servoHigh < servoLow * 0.85,
    `the servo should smooth the detail up high: ${servoLow.toFixed(3)} vs ${servoHigh.toFixed(3)}`,
  );
});

test('switching optical amplitude off changes the envelope, not the pitch', () => {
  const attackPeak = (optical: boolean): number => {
    const m = new Machine({ sampleRate: SR, fidelity: { opticalAmplitude: optical } });
    openVoice(m);
    return peak(m.bounce(0.005));
  };
  assert.ok(
    attackPeak(false) > attackPeak(true) * 2,
    'the bypass should reach full level far sooner than the bulb and cell can',
  );
});

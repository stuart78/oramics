/**
 * The voice.
 *
 * Monophonic, four timbres. One master pitch drives four drawn-wavetable
 * oscillators in unison; each has its own amplitude lane through its own
 * optical attenuator, and the four are summed. That is the machine: polyphony
 * came later, on tape.
 *
 * Nothing in this file touches Web Audio, the DOM, or Node. It is a plain
 * sample-in/sample-out object so the same code runs in an AudioWorklet, in an
 * offline bounce at whatever speed the CPU allows, and in a unit test.
 */

import { ControlLane } from './lane.js';
import { DEFAULT_RELAYS, RelayBank, type RelayOptions } from './neume.js';
import { DEFAULT_PLATE, PlateReverb, type PlateOptions } from './reverb.js';
import { DEFAULT_SCANNER_OPTS, FlyingSpotScanner, type ScannerOptions } from './scanner.js';
import { Slide } from './slide.js';
import { DEFAULT_VACTROL, DirectGain, Vactrol, type AmplitudeStage, type VactrolOptions } from './vactrol.js';
import { Wavetable } from './wavetable.js';

export const TIMBRE_COUNT = 4;

/**
 * The legible fallback scale: four octaves, A1 to A5, logarithmic. Only used
 * when `linearPitchScale` is off — the machine itself had no such thing.
 */
export const PITCH_RANGE = { minHz: 55, maxHz: 880 } as const;

/**
 * Top of the linear pitch lane, in Hz.
 *
 * The strips reach 9999 Hz, but a lane scaled to that puts everything musical
 * in the bottom tenth and is unusable to draw on. A thousand is the natural
 * stopping point: it is three of the four decades, and A5 at 880 Hz sits near
 * the top of the sheet.
 */
export const PITCH_LANE_MAX_HZ = 1000;

export interface Fidelity {
  /**
   * Round pitch to a whole number of Hertz. The machine took frequency as
   * three BCD digits, so 100 -> 101 Hz is a 17-cent step down low and a 2-cent
   * step up high. Uneven resolution across the range is the point.
   */
  integerHzPitch: boolean;
  /** Route amplitude through the bulb-and-photoresistor model. */
  opticalAmplitude: boolean;
  /** Sum to mono, as the machine did. */
  monoSum: boolean;
  /**
   * Read the pitch lane as a linear number of Hertz, which is what the painted
   * code meant. Off gives a logarithmic musical scale — easier to draw a tune
   * on, and an anachronism.
   */
  linearPitchScale: boolean;
  /**
   * Put the pitch through the bank of latching relays, so decimal carries take
   * a few milliseconds and sweep through frequencies nobody painted.
   */
  relayLag: boolean;
  /**
   * Generate timbres by running the flying-spot servo over the painted slide,
   * rather than replaying the curve it would settle on. Off, you get a clean
   * wavetable of the slide's top edge: the same shape with none of the ring,
   * lag, loss of lock or pitch-dependent smearing.
   */
  servoScanner: boolean;
  /**
   * Let the transport strip drive the read heads. Strip 10 did exactly this,
   * and because the strip is itself read by a head it warps its own time axis.
   */
  transportLane: boolean;
}

export const FAITHFUL: Fidelity = {
  integerHzPitch: true,
  linearPitchScale: true,
  relayLag: true,
  opticalAmplitude: true,
  monoSum: true,
  servoScanner: true,
  transportLane: true,
};

export interface MachineOptions {
  sampleRate: number;
  fidelity?: Partial<Fidelity>;
  vactrol?: VactrolOptions;
  scanner?: ScannerOptions;
  relays?: RelayOptions;
  plate?: PlateOptions;
  /** Full-scale vibrato deflection, in cents. */
  vibratoDepthCents?: number;
}

/** The vertical slice of a slide one timbre is reading, in -1..1. */
export interface ScanWindow {
  low: number;
  high: number;
}

export type LaneName = 'pitch' | 'vibrato' | 'reverb' | 'transport' | `amp${1 | 2 | 3 | 4}`;

const LANE_NAMES: LaneName[] = [
  'pitch',
  'vibrato',
  'reverb',
  'transport',
  'amp1',
  'amp2',
  'amp3',
  'amp4',
];

export class Machine {
  readonly sampleRate: number;
  readonly lanes: Record<LaneName, ControlLane>;
  readonly fidelity: Fidelity;

  /** Bypass tables, null until the wavetable path actually asks for one. */
  private timbres: (Wavetable | null)[];
  private slides: Slide[];
  /**
   * The slide each timbre was reading before the current one, kept alive with
   * its own scanner so a swap can be crossfaded rather than cut.
   *
   * Blending the two opacity fields instead does not work: where the old and
   * new edges are far apart the blend sits near half opacity, which reads as
   * zero error, and the loop has nothing to track. Crossfading the two outputs
   * is unconditionally smooth because each one is continuous on its own.
   */
  private previousSlides: Slide[];
  private previousScanners: FlyingSpotScanner[];
  /** Samples of crossfade remaining, per timbre. */
  private fadeLeft: Int32Array;
  private readonly fadeSamples: number;
  private scanners: FlyingSpotScanner[];
  private windows: ScanWindow[];
  private amps: AmplitudeStage[];
  /**
   * DC blocker state. The scanner's output is a deflection voltage, and it
   * rests hard against a rail whenever the loop has nothing to track — an empty
   * carrier, or a long gap in the paint. The real machine was AC-coupled into
   * the mixer, so that read as silence rather than a full-scale offset.
   */
  private dcX = 0;
  private dcY = 0;
  private readonly dcR: number;
  private readonly relays: RelayBank;
  private readonly plate: PlateReverb;
  /**
   * Flat arrays of the same lanes the record holds. `for...of` over a record's
   * keys allocates an iterator every sample, which is exactly the kind of
   * garbage that turns into a click on the audio thread.
   */
  private allLanes: ControlLane[];
  private ampLanes: ControlLane[];
  private phase = 0;
  private vibratoDepthCents: number;
  private vactrolOpts: VactrolOptions;

  /** Most recent values, for the UI. Not used by the DSP. */
  readonly meters = { hz: 0, gains: new Float32Array(TIMBRE_COUNT) };

  constructor(opts: MachineOptions) {
    this.sampleRate = opts.sampleRate;
    this.fidelity = { ...FAITHFUL, ...opts.fidelity };
    this.vactrolOpts = opts.vactrol ?? DEFAULT_VACTROL;
    this.vibratoDepthCents = opts.vibratoDepthCents ?? 50;
    // One-pole DC blocker at roughly 10 Hz.
    this.dcR = 1 - (2 * Math.PI * 10) / this.sampleRate;
    this.relays = new RelayBank(this.sampleRate, opts.relays ?? DEFAULT_RELAYS);
    this.plate = new PlateReverb(this.sampleRate, opts.plate ?? DEFAULT_PLATE);

    this.lanes = Object.fromEntries(LANE_NAMES.map((n) => [n, new ControlLane()])) as Record<
      LaneName,
      ControlLane
    >;
    // An unloaded pitch lane should sit mid-range, not at 55 Hz; an unloaded
    // amplitude lane should be silent.
    this.lanes.pitch.defaultValue = 0.5;
    this.lanes.vibrato.defaultValue = 0.5;
    this.lanes.transport.defaultValue = 0.5;
    // The pitch relays latch, so a gap in the strip sustains the last frequency
    // rather than dropping to nothing. Everything else rests.
    this.lanes.pitch.gapBehaviour = 'hold';
    this.lanes.transport.gapBehaviour = 'hold';

    this.allLanes = LANE_NAMES.map((n) => this.lanes[n]);
    this.ampLanes = [this.lanes.amp1, this.lanes.amp2, this.lanes.amp3, this.lanes.amp4];
    this.timbres = Array.from({ length: TIMBRE_COUNT }, () => null);
    // Slides are immutable, so one sine serves all four until they are replaced.
    const defaultSlide = Slide.sine();
    this.slides = Array.from({ length: TIMBRE_COUNT }, () => defaultSlide);
    this.previousSlides = Array.from({ length: TIMBRE_COUNT }, () => defaultSlide);
    this.fadeLeft = new Int32Array(TIMBRE_COUNT);
    // Long enough to hide the handover, short enough that a brush stroke still
    // feels immediate.
    this.fadeSamples = Math.round(this.sampleRate * 0.025);
    this.scanners = Array.from(
      { length: TIMBRE_COUNT },
      () => new FlyingSpotScanner(this.sampleRate, opts.scanner ?? DEFAULT_SCANNER_OPTS),
    );
    this.previousScanners = Array.from(
      { length: TIMBRE_COUNT },
      () => new FlyingSpotScanner(this.sampleRate, opts.scanner ?? DEFAULT_SCANNER_OPTS),
    );
    this.windows = Array.from({ length: TIMBRE_COUNT }, () => ({ low: -1, high: 1 }));
    this.amps = this.makeAmps();
  }

  private makeAmps(): AmplitudeStage[] {
    return Array.from({ length: TIMBRE_COUNT }, () =>
      this.fidelity.opticalAmplitude
        ? new Vactrol(this.sampleRate, this.vactrolOpts)
        : new DirectGain(),
    );
  }

  setTimbre(index: number, table: Wavetable): void {
    this.assertTimbre(index);
    this.timbres[index] = table;
  }

  /**
   * Install a painted slide.
   *
   * Must stay cheap: this is called on the audio thread every time someone
   * moves the brush. Deriving the wavetable bypass here cost 57 ms a go —
   * twenty times a whole render quantum — and stalled playback while painting.
   * It is built on demand instead, in `wavetableFor`.
   */
  setSlide(index: number, slide: Slide): void {
    this.assertTimbre(index);
    // Hand over to a second loop started from exactly where this one is, so
    // the outgoing sound keeps running while the incoming one settles.
    this.previousSlides[index] = this.slides[index]!;
    this.previousScanners[index]!.copyStateFrom(this.scanners[index]!);
    this.fadeLeft[index] = this.fadeSamples;
    this.slides[index] = slide;
    this.timbres[index] = null;
  }

  /**
   * The bypass table for a slide, built on first use and cached.
   *
   * Derived from the slide's top edge so both paths describe the same painting
   * and the fidelity toggle is a fair comparison, not a swap between unrelated
   * sounds. Only reached when `servoScanner` is off.
   */
  private wavetableFor(index: number): Wavetable {
    let table = this.timbres[index];
    if (!table) {
      table = Wavetable.fromContour(this.slides[index]!.topEdgeContour());
      this.timbres[index] = table;
    }
    return table;
  }

  /** Narrow a timbre to one ribbon of a slide that carries several. */
  setScanWindow(index: number, window: ScanWindow): void {
    this.assertTimbre(index);
    this.windows[index] = window;
  }

  setScannerOptions(opts: ScannerOptions): void {
    for (const s of this.scanners) s.setOptions(opts);
  }

  private assertTimbre(index: number): void {
    if (index < 0 || index >= TIMBRE_COUNT) throw new Error(`No timbre ${index}`);
  }

  /** Toggling optical amplitude rebuilds the attenuators, so do it off the audio thread. */
  setFidelity(patch: Partial<Fidelity>): void {
    const wasOptical = this.fidelity.opticalAmplitude;
    Object.assign(this.fidelity, patch);
    if (this.fidelity.opticalAmplitude !== wasOptical) this.amps = this.makeAmps();
  }

  setVibratoDepthCents(cents: number): void {
    this.vibratoDepthCents = cents;
  }

  /**
   * Set every lane's speed at once — the faithful, single-clutch behaviour.
   *
   * Individual lanes can still be set afterwards to run at their own rate; the
   * transport strip scales whatever they end up at.
   */
  setGlobalSpeed(speed: number): void {
    for (const name of LANE_NAMES) this.lanes[name].speed = speed;
  }

  setPlateOptions(opts: PlateOptions): void {
    this.plate.setOptions(opts);
  }

  reset(): void {
    this.phase = 0;
    for (const lane of this.allLanes) lane.reset();
    for (const a of this.amps) a.reset();
    for (const s of this.scanners) s.reset();
    for (const s of this.previousScanners) s.reset();
    this.fadeLeft.fill(0);
    this.relays.reset();
    this.plate.clear();
    this.dcX = 0;
    this.dcY = 0;
  }

  /**
   * Lane height to frequency.
   *
   * Linear is the authentic reading: the painted code is a decimal number of
   * Hertz, and the resistor bank makes the time-base run at that frequency, so
   * height maps straight onto Hz. Octaves are unevenly spaced as a result —
   * 110 Hz sits at a ninth of the way up and 880 at seven eighths.
   */
  private laneToHz(v: number): number {
    const clamped = Math.max(0, Math.min(1, v));
    const hz = this.fidelity.linearPitchScale
      ? clamped * PITCH_LANE_MAX_HZ
      : PITCH_RANGE.minHz * Math.pow(PITCH_RANGE.maxHz / PITCH_RANGE.minHz, clamped);
    return this.fidelity.integerHzPitch ? Math.round(hz) : hz;
  }

  /**
   * Render `frames` samples into `out`. This is the only method the worklet
   * calls, and it must not allocate.
   */
  render(out: Float32Array, frames: number): void {
    const dt = 1 / this.sampleRate;
    const { pitch, vibrato } = this.lanes;
    const ampLanes = this.ampLanes;
    const allLanes = this.allLanes;

    for (let i = 0; i < frames; i++) {
      let baseHz = this.laneToHz(pitch.read());
      if (this.fidelity.relayLag) {
        // The photocells aim the bank; the bank reports what the resistors
        // currently spell, which lags and overshoots through a carry.
        this.relays.setTargetHz(baseHz);
        baseHz = this.relays.step();
      }
      // Vibrato is bipolar about the sheet's centre line.
      const bend = (vibrato.read() - 0.5) * 2 * this.vibratoDepthCents;
      const hz = baseHz * Math.pow(2, bend / 1200);

      let sum = 0;
      for (let t = 0; t < TIMBRE_COUNT; t++) {
        const gain = this.amps[t]!.process(ampLanes[t]!.read());
        this.meters.gains[t] = gain;

        if (this.fidelity.servoScanner) {
          // The loop must keep running even while the voice is silent: its
          // state carries across cycles, so skipping it would make a note's
          // timbre depend on how long the previous silence was.
          const w = this.windows[t]!;
          let spot = this.scanners[t]!.step(this.slides[t]!, hz, w.low, w.high);
          if (this.fadeLeft[t]! > 0) {
            const outgoing = this.previousScanners[t]!.step(
              this.previousSlides[t]!,
              hz,
              w.low,
              w.high,
            );
            this.fadeLeft[t]!--;
            const mix = 1 - this.fadeLeft[t]! / this.fadeSamples;
            spot = outgoing + (spot - outgoing) * mix;
          }
          if (gain > 0) sum += spot * gain;
        } else if (gain > 0) {
          sum += this.wavetableFor(t).sample(this.phase, hz, this.sampleRate) * gain;
        }
      }

      this.phase += hz / this.sampleRate;
      if (this.phase >= 1) this.phase -= Math.floor(this.phase);

      let mixed = sum / TIMBRE_COUNT;
      // Strip 9 sets how much of the whole four-timbre mix reaches the plate.
      // Always run the tank: muting it would cut the tail the moment the send
      // came down, and a tail outlasting the line that made it is the point.
      const wet = this.plate.process(mixed * this.lanes.reverb.read());
      mixed += wet;
      this.dcY = mixed - this.dcX + this.dcR * this.dcY;
      this.dcX = mixed;
      out[i] = this.dcY;
      this.meters.hz = hz;

      // Strip 10 drives the clutch. The centre line is normal speed, the top
      // rail double, the bottom a dead stop — and since the transport strip is
      // itself read by a head, it warps its own time axis as it goes.
      //
      // Applied to the time step, not written onto each lane's speed: that
      // field is the per-lane multiplier, and overwriting it destroyed the
      // ability to run heads at different rates.
      const drive = this.fidelity.transportLane ? this.lanes.transport.read() * 2 : 1;
      const step = dt * drive;
      for (let l = 0; l < allLanes.length; l++) allLanes[l]!.advance(step);
    }
  }

  /**
   * Render `seconds` of audio as fast as the CPU allows. Same code path as the
   * worklet, which is the whole reason the engine has no platform dependencies.
   */
  bounce(seconds: number, blockSize = 128): Float32Array {
    const total = Math.ceil(seconds * this.sampleRate);
    const out = new Float32Array(total);
    const block = new Float32Array(blockSize);
    for (let i = 0; i < total; i += blockSize) {
      const n = Math.min(blockSize, total - i);
      this.render(block, n);
      out.set(block.subarray(0, n), i);
    }
    return out;
  }
}

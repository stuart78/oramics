/**
 * The flying-spot scanner: the oscillator that actually made Oram's timbres.
 *
 * A dot sweeps across a CRT once per cycle, behind a painted glass slide, with
 * a photomultiplier watching the whole screen. Wrench: "if obscured by the
 * opaque part of the drawn waveform, the photomultiplier would detect no light,
 * and the beam would move higher until the photomultiplier could see it."
 *
 * So dark pushes the spot up, light pulls it down, and it balances on the TOP
 * edge of the paint. The Y deflection is the audio output. Everything
 * distinctive about the sound falls out of running that loop honestly rather
 * than precomputing the curve it settles on:
 *
 *   pitch-dependent timbre  the sweep rate is the note frequency but the loop
 *                           bandwidth is fixed, so high notes outrun the servo
 *                           and come out duller and phase-smeared
 *   inharmonic ring         overshoot on a steep edge rings at the loop's own
 *                           natural frequency, which does not transpose
 *   loss of lock            clear glass reads as light, so a gap in the paint
 *                           drops the spot toward the bottom rail and it has to
 *                           slew back when paint resumes
 *   drift                   loop state carries across the flyback, so the
 *                           waveform evolves instead of repeating exactly
 *
 * A wavetable can imitate the first cycle and none of the rest.
 */

import type { ScannableSlide } from './slide.js';

export interface ScannerOptions {
  /**
   * Natural frequency of the deflection loop, in Hz. Fixed in absolute terms —
   * this is the constant that the note frequency is measured against, and the
   * single most important number in the model. Lower is lazier and darker.
   */
  loopHz: number;
  /** Damping ratio. Below 1 rings; around 0.4 is an audibly underdamped servo. */
  damping: number;
  /**
   * Photocell null point. The spot rests where transmitted light equals this,
   * i.e. half-covered, which is the top edge of a stroke.
   */
  reference: number;
  /**
   * Loop gain. High values approach the bang-bang behaviour Wrench describes,
   * where the spot hunts audibly along the edge instead of riding it smoothly.
   */
  gain: number;
  /** Lowest and highest the deflection amplifier can drive, in -1..1. */
  railLow: number;
  railHigh: number;
  /**
   * Capture sweep rate, in deflection units per second.
   *
   * Wrench's own transparencies were "filled solid black below the line", which
   * makes the edge globally attracting: anywhere above it is light and falls,
   * anywhere below is dark and climbs. Oram's surviving slides are not like
   * that — they are free-floating ribbons with clear glass underneath, so a
   * spot below one sees light, descends, and dies on the bottom rail with
   * nothing to pull it back.
   *
   * A real tracking servo answers this with a search mode, and so does this
   * one: when the spot is railed with nothing overhead it sweeps upward until
   * it meets paint, then hands back to the loop, which climbs the stroke to its
   * top edge. Audible as a quick swoop into the note.
   */
  searchSlew: number;
}

export const DEFAULT_SCANNER_OPTS: ScannerOptions = {
  loopHz: 2600,
  damping: 0.42,
  reference: 0.5,
  gain: 1.9,
  railLow: -1,
  railHigh: 1,
  searchSlew: 40,
};

export class FlyingSpotScanner {
  private y = 0;
  private v = 0;
  private x = 0;
  private searching = true;
  /** +1 sweeping up, -1 sweeping back down. */
  private searchDirection = 1;
  private opts: ScannerOptions;
  private readonly sampleRate: number;
  /** Angular natural frequency, clamped for integration stability. */
  private omega = 0;

  constructor(sampleRate: number, opts: ScannerOptions = DEFAULT_SCANNER_OPTS) {
    this.sampleRate = sampleRate;
    this.opts = opts;
    this.setOptions(opts);
  }

  setOptions(opts: ScannerOptions): void {
    this.opts = opts;
    // Semi-implicit Euler goes unstable as omega*dt approaches 1. Cap the loop
    // at an eighth of the sample rate so a silly loopHz degrades to "very fast
    // servo" instead of blowing up.
    const maxHz = this.sampleRate / 8;
    this.omega = 2 * Math.PI * Math.min(opts.loopHz, maxHz);
  }

  reset(): void {
    // Start railed and searching: capture from a known state rather than
    // wherever the previous note happened to leave the spot.
    this.y = this.opts.railLow;
    this.v = 0;
    this.x = 0;
    this.searching = true;
    this.searchDirection = 1;
  }

  /** True while the loop has lost the paint and is sweeping to find it. */
  get isSearching(): boolean {
    return this.searching;
  }

  /**
   * Adopt another scanner's state, so a second loop can be started from exactly
   * where the first one is. Used when a slide is replaced: the outgoing scanner
   * keeps tracking the old paint while the incoming one takes over, and the two
   * outputs are crossfaded. Both are continuous, so the blend is too.
   */
  copyStateFrom(other: FlyingSpotScanner): void {
    this.y = other.y;
    this.v = other.v;
    this.x = other.x;
    this.searching = other.searching;
    this.searchDirection = other.searchDirection;
  }

  /** Sweep position within the current cycle, 0-1. For the UI. */
  get phase(): number {
    return this.x;
  }

  /** Where the spot currently sits, -1..1. For the UI. */
  get position(): number {
    return this.y;
  }

  /**
   * Advance one audio sample at `hz` and return the deflection.
   *
   * `window` narrows the vertical travel to a single ribbon — the slide holds
   * four, and the real machine selected one by physically positioning the glass.
   */
  step(slide: ScannableSlide, hz: number, windowLow = -1, windowHigh = 1): number {
    const dt = 1 / this.sampleRate;
    const { reference, gain, damping } = this.opts;
    const omega = this.omega;
    const low = this.opts.railLow;
    const high = this.opts.railHigh;

    // The deflection range is fixed; selecting a ribbon means moving the glass
    // in front of the spot. So the window is an offset and scale applied to the
    // slide, not a restriction on travel — whichever ribbon you pick is read
    // across the full deflection range and plays at full scale.
    const lowIn01 = (windowLow + 1) / 2;
    const highIn01 = (windowHigh + 1) / 2;
    const y01 = lowIn01 + ((this.y - low) / (high - low)) * (highIn01 - lowIn01);

    const light = slide.light(this.x, y01);

    if (this.searching) {
      // Sweep up looking for paint. The first thing found from below is a
      // stroke's underside; handing back to the loop here lets it climb the
      // stroke to the top edge, which is where it belongs.
      if (light < reference) {
        this.searching = false;
        this.v = 0;
      } else if (!slide.columnHasPaint(this.x)) {
        // Bare glass, not a lost stroke. Sit dark at the rail rather than
        // hunting — an empty carrier should be silent, not a sawtooth.
        this.searching = false;
        this.y = low;
        this.v = 0;
      } else {
        // Reverse at the rails rather than jumping back to the bottom. A
        // teleport is a full-scale discontinuity and the loudest click the
        // instrument can make; sweeping back down is continuous and sounds
        // like the hunt it is.
        this.y += this.searchDirection * this.opts.searchSlew * dt;
        if (this.y >= high) {
          this.y = high;
          this.searchDirection = -1;
        } else if (this.y <= low) {
          this.y = low;
          this.searchDirection = 1;
        }
      }
    } else {
      // Light means the spot is clear of the paint, so pull it down; darkness
      // means it is covered, so push it up.
      const error = reference - light;
      const accel = omega * omega * gain * error - 2 * damping * omega * this.v;

      this.v += accel * dt;
      this.y += this.v * dt;

      if (this.y < low) {
        this.y = low;
        // The deflection amplifier is saturated; it cannot keep integrating.
        if (this.v < 0) this.v = 0;
        // Pinned at the bottom in open glass, but there is paint somewhere in
        // this column: the stroke was lost rather than absent, so reacquire.
        if (light > 0.98 && slide.columnHasPaint(this.x)) this.searching = true;
      } else if (this.y > high) {
        this.y = high;
        if (this.v > 0) this.v = 0;
      }
    }

    // Flyback carries the loop's state into the next cycle — that is where the
    // slow evolution of the tone comes from.
    this.x += hz / this.sampleRate;
    if (this.x >= 1) this.x -= Math.floor(this.x);

    return this.y;
  }
}

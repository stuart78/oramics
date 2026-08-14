/**
 * Pitch, the way the machine actually did it.
 *
 * Wrench, on the four pitch strips: "one strip would set the number of units of
 * cycles per second; one set the number of tens of cycles; a third set the
 * number of hundreds of cycles; the last would set the number of thousands of
 * cycles per second."
 *
 * So the painted code *is* the frequency, as a decimal number of Hertz. Not a
 * note, not a scale position. Two consequences that shape everything:
 *
 *   Pitch is linear in Hz.  The relays "switch in banks of resistors and make
 *   the time-base run at whatever frequency" — resistors in parallel, so
 *   conductance sums and the oscillator's frequency follows the coded number
 *   proportionally. An octave is a doubling, so it occupies twice the span of
 *   the one below it. A logarithmic pitch axis is a modern convenience, not
 *   what she was working on.
 *
 *   Resolution is one Hertz everywhere.  Which is 31 cents at 55 Hz and 2
 *   cents at 880 Hz. Low notes are audibly stepped and high ones are smooth;
 *   that unevenness is a fingerprint, not a defect.
 *
 * And the digit code is not the 8-4-2-1 BCD you would reach for today. Wrench
 * again: "The track on the lower edge of the film does nought or one; the next
 * one up does nought and two; the next does nought and four; the top-most track
 * does nought and two again: hence, weighted binary."
 */

/** Track weights, bottom edge of the film first. Sum 9, so one decimal digit. */
export const NEUME_WEIGHTS = [1, 2, 4, 2] as const;

/** Units, tens, hundreds, thousands of cycles per second. */
export const NEUME_DIGITS = 4;

export const NEUME_TRACKS = NEUME_WEIGHTS.length * NEUME_DIGITS;

/** Largest frequency the strips can express: 9999 Hz. */
export const NEUME_MAX_HZ = 10 ** NEUME_DIGITS - 1;

/**
 * Decode painted tracks into a frequency.
 *
 * `bits` is indexed [digit][track], digit 0 = units, track 0 = the film's lower
 * edge. A digit's tracks are summed with the 1-2-4-2 weights, so several
 * paintings give the same digit — 4 is either the single 4 track or both 2s.
 * The machine cannot tell them apart and neither can we.
 */
export const decodeNeume = (bits: ReadonlyArray<ReadonlyArray<boolean>>): number => {
  let hz = 0;
  for (let d = 0; d < bits.length; d++) {
    const tracks = bits[d]!;
    let digit = 0;
    for (let t = 0; t < tracks.length && t < NEUME_WEIGHTS.length; t++) {
      if (tracks[t]) digit += NEUME_WEIGHTS[t]!;
    }
    hz += digit * 10 ** d;
  }
  return hz;
};

/**
 * Paint a frequency, preferring the lowest-numbered tracks.
 *
 * A digit above 9 cannot be expressed, and neither can a frequency needing more
 * digits than the strips carry, so both are clamped rather than wrapping.
 */
export const encodeNeume = (hz: number, digits = NEUME_DIGITS): boolean[][] => {
  const clamped = Math.max(0, Math.min(10 ** digits - 1, Math.round(hz)));
  const out: boolean[][] = [];
  for (let d = 0; d < digits; d++) {
    const digit = Math.floor(clamped / 10 ** d) % 10;
    const tracks = [false, false, false, false];
    let remaining = digit;
    // Greedy over 4, 2, 2, 1 — the descending weights — which reproduces every
    // digit 0-9 exactly.
    for (const t of [2, 1, 3, 0]) {
      const w = NEUME_WEIGHTS[t]!;
      if (remaining >= w) {
        tracks[t] = true;
        remaining -= w;
      }
    }
    out.push(tracks);
  }
  return out;
};

export interface RelayOptions {
  /** Mean operate time of a latching relay, in seconds. */
  operateS: number;
  /** Spread between individual relays, as a fraction of the mean. */
  spread: number;
}

export const DEFAULT_RELAYS: RelayOptions = { operateS: 0.011, spread: 0.55 };

/**
 * The bank of latching relays between the photocells and the resistor network.
 *
 * They are mechanical and they do not move together. Changing 199 Hz to 200 Hz
 * flips eight tracks at once, and for a few milliseconds the resistor bank
 * holds some mixture of the old code and the new — so the oscillator sweeps
 * through a frequency nobody painted. Small changes within a digit are clean;
 * decimal carries glitch. That asymmetry is audible, and it is the reason a
 * melody on this machine has a particular stumble to it.
 *
 * Latching also means the code persists: between neumes the pitch holds rather
 * than falling silent, which is why a painted strip is mostly blank.
 */
export class RelayBank {
  private readonly state: boolean[];
  private readonly target: boolean[];
  /** Samples remaining before each relay reaches its target. */
  private readonly countdown: Int32Array;
  private readonly operateSamples: Int32Array;

  constructor(sampleRate: number, opts: RelayOptions = DEFAULT_RELAYS) {
    this.state = new Array(NEUME_TRACKS).fill(false);
    this.target = new Array(NEUME_TRACKS).fill(false);
    this.countdown = new Int32Array(NEUME_TRACKS);
    this.operateSamples = new Int32Array(NEUME_TRACKS);
    for (let i = 0; i < NEUME_TRACKS; i++) {
      // Fixed per relay rather than random per event: a given relay is
      // consistently a little quicker or slower than its neighbours, so the
      // same transition glitches the same way every time.
      const bias = 1 + opts.spread * (((i * 2654435761) % 1000) / 1000 - 0.5) * 2;
      this.operateSamples[i] = Math.max(1, Math.round(opts.operateS * bias * sampleRate));
    }
  }

  reset(): void {
    this.state.fill(false);
    this.target.fill(false);
    this.countdown.fill(0);
  }

  /** Aim the bank at a frequency. Only tracks that must change start moving. */
  setTargetHz(hz: number): void {
    const bits = encodeNeume(hz);
    for (let d = 0; d < bits.length; d++) {
      for (let t = 0; t < NEUME_WEIGHTS.length; t++) {
        const i = d * NEUME_WEIGHTS.length + t;
        const want = bits[d]![t]!;
        if (want === this.target[i]) continue;
        this.target[i] = want;
        this.countdown[i] = this.operateSamples[i]!;
      }
    }
  }

  /** Advance one sample and return the frequency the resistor bank now spells. */
  step(): number {
    let hz = 0;
    for (let d = 0; d < NEUME_DIGITS; d++) {
      let digit = 0;
      for (let t = 0; t < NEUME_WEIGHTS.length; t++) {
        const i = d * NEUME_WEIGHTS.length + t;
        if (this.countdown[i]! > 0) {
          this.countdown[i]!--;
          if (this.countdown[i] === 0) this.state[i] = this.target[i]!;
        }
        if (this.state[i]) digit += NEUME_WEIGHTS[t]!;
      }
      hz += digit * 10 ** d;
    }
    return hz;
  }

  /** True while any relay is still travelling. */
  get settling(): boolean {
    for (let i = 0; i < NEUME_TRACKS; i++) if (this.countdown[i]! > 0) return true;
    return false;
  }
}

/**
 * The optical amplitude control.
 *
 * Continuously variable faders did not exist on the budget Graham Wrench was
 * building to in 1965, so level was set by shining a torch bulb at a
 * photoresistor — over 60 dB of range, and about as far from a clean VCA as it
 * is possible to get. Two lags in series:
 *
 *   bulb   a filament has thermal mass. It takes tens of milliseconds to come
 *          up to brightness and about as long to go dark.
 *   LDR    cadmium sulphide recovers asymmetrically. Resistance falls quickly
 *          when light arrives and crawls back up when it leaves, so decays are
 *          several times slower than attacks.
 *
 * The audible consequence is that no envelope drawn on this machine has a sharp
 * attack, and released notes hang on longer than the drawing says. It is one of
 * the strongest fingerprints on the sound, so it is modelled rather than
 * approximated with a linear ramp — and it is switchable, because half the
 * point of the workshop is hearing what happens when you turn it off.
 */

export interface VactrolOptions {
  /** Filament thermal time constant, seconds. */
  bulbTauS: number;
  /** LDR response when light is increasing, seconds. */
  attackTauS: number;
  /** LDR recovery when light is decreasing, seconds. Much slower. */
  releaseTauS: number;
  /** Control range in dB. Below this the output is treated as silent. */
  rangeDb: number;
}

export const DEFAULT_VACTROL: VactrolOptions = {
  bulbTauS: 0.015,
  attackTauS: 0.008,
  releaseTauS: 0.22,
  rangeDb: 60,
};

/** A one-pole coefficient for a given time constant. */
const coeff = (tauS: number, sampleRate: number): number =>
  tauS <= 0 ? 1 : 1 - Math.exp(-1 / (tauS * sampleRate));

export class Vactrol {
  private bulb = 0;
  private cell = 0;
  private bulbC: number;
  private attackC: number;
  private releaseC: number;
  private readonly rangeDb: number;

  constructor(sampleRate: number, opts: VactrolOptions = DEFAULT_VACTROL) {
    this.bulbC = coeff(opts.bulbTauS, sampleRate);
    this.attackC = coeff(opts.attackTauS, sampleRate);
    this.releaseC = coeff(opts.releaseTauS, sampleRate);
    this.rangeDb = opts.rangeDb;
  }

  reset(): void {
    this.bulb = 0;
    this.cell = 0;
  }

  /** Feed a 0-1 control value, get back a linear gain. */
  process(drive: number): number {
    const d = drive < 0 ? 0 : drive > 1 ? 1 : drive;
    this.bulb += (d - this.bulb) * this.bulbC;
    this.cell += (this.bulb - this.cell) * (this.bulb > this.cell ? this.attackC : this.releaseC);
    return this.toGain(this.cell);
  }

  /** Log taper across the cell's range, with a true zero at the bottom. */
  private toGain(v: number): number {
    if (v <= 1e-4) return 0;
    return Math.pow(10, ((v - 1) * this.rangeDb) / 20);
  }

  /** Current linear gain without advancing the model. */
  peek(): number {
    return this.toGain(this.cell);
  }
}

/** Bypass path for the unfaithful half of the workshop: instant, linear. */
export class DirectGain {
  private gain = 0;
  reset(): void {
    this.gain = 0;
  }
  process(drive: number): number {
    this.gain = drive < 0 ? 0 : drive > 1 ? 1 : drive;
    return this.gain;
  }
  peek(): number {
    return this.gain;
  }
}

export type AmplitudeStage = Vactrol | DirectGain;

/**
 * A drawn waveform slide, turned into something playable.
 *
 * Oram's timbres came from four painted glass slides, each in front of a CRT
 * inside a lightproof box. A dot swept across the X axis while a photomultiplier
 * feedback loop dragged it vertically onto the painted contour; the Y voltage
 * was the waveform. That machine imposes two artifacts we want to keep, because
 * they are most of why a drawn square wave does not sound like a square wave:
 *
 *   spot size   the CRT dot has width, so the contour is read blurred
 *   slew        the feedback loop cannot track a vertical edge, so steep
 *               slopes come out ramped and overshooting rather than instant
 *
 * We apply both to the table, then band-limit for digital playback. That order
 * matters: the analog artifacts are part of the instrument, the band-limiting is
 * an artifact of *our* medium and should not be audible as such.
 */

export const TABLE_SIZE = 2048;

export interface ScannerOptions {
  /** CRT spot radius, as a fraction of one cycle. 0 disables the blur. */
  spotSize: number;
  /**
   * Steepest slope the feedback loop can follow, in full-scale units per
   * fraction-of-a-cycle. Lower is a lazier, rounder scanner.
   */
  maxSlope: number;
  /** Overshoot on a slew-limited edge, 0-1. The loop is underdamped. */
  overshoot: number;
}

export const DEFAULT_SCANNER: ScannerOptions = {
  spotSize: 0.004,
  maxSlope: 900,
  overshoot: 0.18,
};

/** Resample an arbitrary-length contour onto the table, wrapping at the ends. */
const resample = (contour: ArrayLike<number>, size: number): Float32Array => {
  const out = new Float32Array(size);
  if (contour.length === 0) return out;
  if (contour.length === 1) return out.fill(contour[0]!);
  for (let i = 0; i < size; i++) {
    const pos = (i / size) * contour.length;
    const i0 = Math.floor(pos) % contour.length;
    const i1 = (i0 + 1) % contour.length;
    const f = pos - Math.floor(pos);
    out[i] = contour[i0]! * (1 - f) + contour[i1]! * f;
  }
  return out;
};

/** Circular Gaussian blur — the finite width of the scanning spot. */
const blur = (table: Float32Array, sigmaSamples: number): Float32Array => {
  if (sigmaSamples <= 0.01) return table;
  const radius = Math.max(1, Math.ceil(sigmaSamples * 3));
  const kernel = new Float32Array(radius * 2 + 1);
  let sum = 0;
  for (let i = -radius; i <= radius; i++) {
    const v = Math.exp(-(i * i) / (2 * sigmaSamples * sigmaSamples));
    kernel[i + radius] = v;
    sum += v;
  }
  for (let i = 0; i < kernel.length; i++) kernel[i]! /= sum;

  const n = table.length;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let acc = 0;
    for (let k = -radius; k <= radius; k++) {
      acc += table[(i + k + n * radius) % n]! * kernel[k + radius]!;
    }
    out[i] = acc;
  }
  return out;
};

/**
 * Slew limit with overshoot, run circularly so the cycle stays continuous.
 *
 * A single forward pass would shift the waveform in phase; running it forward
 * then backward and averaging keeps the contour where it was drawn, which is
 * what a composer expects when they line a peak up with a gridline.
 */
const slew = (table: Float32Array, maxStep: number, overshoot: number): Float32Array => {
  const n = table.length;
  const pass = (src: Float32Array, reverse: boolean): Float32Array => {
    const out = new Float32Array(n);
    // Prime from the far end so the wrap point is not a discontinuity.
    let v = src[reverse ? 0 : n - 1]!;
    let velocity = 0;
    for (let i = 0; i < n; i++) {
      const idx = reverse ? n - 1 - i : i;
      const target = src[idx]!;
      const delta = target - v;
      const step = Math.max(-maxStep, Math.min(maxStep, delta));
      // Underdamped: the loop carries momentum past the target on fast edges.
      velocity = velocity * overshoot + step;
      v += velocity;
      out[idx] = v;
    }
    return out;
  };
  const fwd = pass(table, false);
  const rev = pass(table, true);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = (fwd[i]! + rev[i]!) * 0.5;
  return out;
};

interface Spectrum {
  re: Float32Array;
  im: Float32Array;
  n: number;
}

/**
 * One cycle of sine and cosine at the table's resolution.
 *
 * Every angle in the transform is a multiple of 2*pi/n, so they can all be read
 * from here instead of calling Math.cos. That was the whole cost of building a
 * wavetable: 8.4 million trig calls, about 55 ms.
 */
const trigTables = new Map<number, { cos: Float32Array; sin: Float32Array }>();

const trigFor = (n: number): { cos: Float32Array; sin: Float32Array } => {
  let t = trigTables.get(n);
  if (!t) {
    const cos = new Float32Array(n);
    const sin = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      cos[i] = Math.cos((2 * Math.PI * i) / n);
      sin[i] = Math.sin((2 * Math.PI * i) / n);
    }
    t = { cos, sin };
    trigTables.set(n, t);
  }
  return t;
};

/**
 * Forward DFT, once per table.
 *
 * The pyramid used to run a full analysis for every mip level, which meant
 * doing this same work eight times over — 57 ms to build one wavetable. The
 * levels differ only in how many partials they keep, so analyse once and
 * resynthesise cheaply per level.
 */
const analyse = (table: Float32Array): Spectrum => {
  const n = table.length;
  const half = Math.floor(n / 2);
  const re = new Float32Array(half);
  const im = new Float32Array(half);
  const { cos, sin } = trigFor(n);
  const scale = 2 / n;
  for (let h = 1; h < half; h++) {
    let sre = 0;
    let sim = 0;
    // Angle index advances by h each step and wraps, which is the same as
    // (h * i) mod n without the multiply or the modulo.
    let k = 0;
    for (let i = 0; i < n; i++) {
      const v = table[i]!;
      sre += v * cos[k]!;
      sim -= v * sin[k]!; // e^-jwt
      k += h;
      if (k >= n) k -= n;
    }
    re[h] = sre * scale;
    im[h] = sim * scale;
  }
  return { re, im, n };
};

/** Resynthesise keeping only the first `harmonics` partials. */
const synthesise = (spectrum: Spectrum, harmonics: number): Float32Array => {
  const { re, im, n } = spectrum;
  const out = new Float32Array(n);
  const { cos, sin } = trigFor(n);
  const limit = Math.max(1, Math.min(harmonics, re.length - 1));
  for (let h = 1; h <= limit; h++) {
    const hr = re[h]!;
    const hi = im[h]!;
    if (hr === 0 && hi === 0) continue;
    let k = 0;
    for (let i = 0; i < n; i++) {
      out[i] = out[i]! + (hr * cos[k]! - hi * sin[k]!);
      k += h;
      if (k >= n) k -= n;
    }
  }
  return out;
};

/**
 * A mip pyramid of progressively band-limited copies. Level 0 is the raw
 * scanned table; level k holds at most `maxHarmonics >> k` partials, and
 * playback picks the level whose top partial stays under Nyquist.
 */
export class Wavetable {
  readonly levels: Float32Array[];

  private constructor(levels: Float32Array[]) {
    this.levels = levels;
  }

  /** Build from a drawn contour in -1..1, sampled left to right across one cycle. */
  static fromContour(
    contour: ArrayLike<number>,
    scanner: ScannerOptions = DEFAULT_SCANNER,
    mipLevels = 8,
  ): Wavetable {
    let table = resample(contour, TABLE_SIZE);
    table = slew(table, scanner.maxSlope / TABLE_SIZE, scanner.overshoot);
    table = blur(table, scanner.spotSize * TABLE_SIZE);

    const levels: Float32Array[] = [table];
    const spectrum = analyse(table);
    for (let k = 1; k < mipLevels; k++) {
      const harmonics = Math.floor(TABLE_SIZE / 2 / Math.pow(2, k));
      if (harmonics < 1) break;
      levels.push(synthesise(spectrum, harmonics));
    }
    return new Wavetable(levels);
  }

  /** A pure sine, for tests and for the default state of an unassigned slide. */
  static sine(): Wavetable {
    const c = new Float32Array(TABLE_SIZE);
    for (let i = 0; i < TABLE_SIZE; i++) c[i] = Math.sin((2 * Math.PI * i) / TABLE_SIZE);
    return new Wavetable([c]);
  }

  /**
   * Read at `phase` (0-1) playing at `hz`. Picks a mip level from the pitch so
   * high notes do not alias, and interpolates linearly within it.
   */
  sample(phase: number, hz: number, sampleRate: number): number {
    const maxHarmonic = Math.max(1, sampleRate / 2 / Math.max(hz, 1e-6));
    const level = Math.max(
      0,
      Math.min(this.levels.length - 1, Math.floor(Math.log2(TABLE_SIZE / 2 / maxHarmonic))),
    );
    const table = this.levels[level]!;
    const n = table.length;
    const pos = (phase - Math.floor(phase)) * n;
    const i0 = Math.floor(pos);
    const i1 = (i0 + 1) % n;
    const f = pos - i0;
    return table[i0]! * (1 - f) + table[i1]! * f;
  }
}

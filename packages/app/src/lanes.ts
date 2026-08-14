/**
 * The lane set the UI presents, matching the printed sheet band for band so a
 * scanned page and an on-screen drawing are the same thing.
 */

import { SLIDE_HEIGHT, SLIDE_WIDTH, type LaneName } from '@oramics/engine';

export { SLIDE_WIDTH, SLIDE_HEIGHT };

/**
 * Samples per lane. The field is 300 mm, so this is 10 samples per millimetre —
 * finer than anything a pen can resolve, and 100 samples per second of audio.
 */
export const LANE_SAMPLES = 3000;

/** Points per drawn waveform cycle. The engine resamples to its own table size. */
export const TIMBRE_SAMPLES = 512;

export interface LaneDef {
  /** Engine lane. */
  name: LaneName;
  /** Role id on the printed sheet, used as the PDF overlay key. */
  role: string;
  label: string;
  hint: string;
  /** Value the engine falls back to where nothing is drawn. */
  rest: number;
  /** Undrawn stretches sustain the last value instead of resting. */
  hold?: boolean;
  /** Draw a centre line and read deviation from it. */
  bipolar: boolean;
  /** Relative height, mirroring the printed band weights. */
  weight: number;
  /** Not yet wired to anything in the engine. */
  pending?: boolean;
}

export const LANE_DEFS: LaneDef[] = [
  { name: 'pitch', role: 'PCH', label: 'Pitch', hint: 'height = Hertz, linear', rest: 0.5, hold: true, bipolar: false, weight: 2.4 },
  { name: 'amp1', role: 'AMP1', label: 'Amplitude 1', hint: 'height = loudness', rest: 0, bipolar: false, weight: 1.4 },
  { name: 'amp2', role: 'AMP2', label: 'Amplitude 2', hint: 'height = loudness', rest: 0, bipolar: false, weight: 1.4 },
  { name: 'amp3', role: 'AMP3', label: 'Amplitude 3', hint: 'height = loudness', rest: 0, bipolar: false, weight: 1.4 },
  { name: 'amp4', role: 'AMP4', label: 'Amplitude 4', hint: 'height = loudness', rest: 0, bipolar: false, weight: 1.4 },
  { name: 'vibrato', role: 'VIB', label: 'Vibrato', hint: 'wobble around the centre', rest: 0.5, bipolar: true, weight: 1.1 },
  { name: 'reverb', role: 'REV', label: 'Reverberation', hint: 'up = wetter', rest: 0, bipolar: false, weight: 1 },
  { name: 'transport', role: 'TRN', label: 'Transport', hint: 'centre = normal speed', rest: 0.5, hold: true, bipolar: true, weight: 1 },
];

/**
 * A blank lane is NaN, not a flat line at rest.
 *
 * Blank means "nothing drawn here", which is a different thing from "drawn at
 * zero" and is what a scanned sheet is mostly made of. The engine falls back to
 * the lane's rest value or holds the last one, depending on the lane.
 */
export const makeLane = (_def: LaneDef): Float32Array =>
  new Float32Array(LANE_SAMPLES).fill(Number.NaN);

/** A sine, so an untouched timbre still sounds like something. */
export const makeTimbre = (): Float32Array => {
  const out = new Float32Array(TIMBRE_SAMPLES);
  for (let i = 0; i < TIMBRE_SAMPLES; i++) {
    out[i] = Math.sin((2 * Math.PI * i) / TIMBRE_SAMPLES);
  }
  return out;
};

/**
 * A blank glass slide with one sine ribbon painted on it, so a fresh timbre
 * gives the scanner something to lock onto. The stroke is comfortably wider
 * than the spot, as Oram's are.
 */
export const makeSlideField = (): Float32Array => {
  const field = new Float32Array(SLIDE_WIDTH * SLIDE_HEIGHT);
  const thickness = Math.round(SLIDE_HEIGHT * 0.14);
  for (let x = 0; x < SLIDE_WIDTH; x++) {
    const v = Math.sin((2 * Math.PI * x) / SLIDE_WIDTH);
    const top = Math.round(((1 - v) / 2) * (SLIDE_HEIGHT - 1 - thickness));
    for (let y = top; y < top + thickness; y++) field[y * SLIDE_WIDTH + x] = 1;
  }
  return field;
};

export type LaneMap = Record<LaneName, Float32Array>;

export const makeAllLanes = (): LaneMap =>
  Object.fromEntries(LANE_DEFS.map((d) => [d.name, makeLane(d)])) as LaneMap;

/**
 * Generating painted slides.
 *
 * The point is to produce something a brush would produce, not a clean curve.
 * The scanner responds to the whole painted field — the thickness of a stroke,
 * where the enamel went thin, whether there is a second ribbon overhead — so a
 * generator that only made smooth single-valued functions would throw away most
 * of what the instrument can do.
 *
 * The controlling axis is the one the Science Museum caption names: "Rounder
 * shapes produce softer sounds. Spikier shapes produce harsher sounds richer in
 * harmonics." Here that is `roundness`, and it works by tilting the spectrum of
 * the stroke's top edge — which is the part the spot actually rides.
 */

import { SLIDE_HEIGHT, SLIDE_WIDTH } from './slide.js';

/** Deterministic RNG, so a seed reproduces a slide exactly. */
export const mulberry32 = (seed: number): (() => number) => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

export interface SlideRecipe {
  /** 0 spiky and harsh, 1 round and soft. Tilts the harmonic falloff. */
  roundness: number;
  /** How many partials the stroke is built from. 0-1. */
  complexity: number;
  /** Stroke weight, 0-1 of the available height. */
  thickness: number;
  /** How much the stroke varies in weight along its length. 0-1. */
  thicknessVariation: number;
  /** Thin and broken enamel — gaps the spot can fall through. 0-1. */
  breakup: number;
  /** Stacked strokes, as on Oram's slides. 1-3. */
  ribbons: number;
}

export interface RecipeBias {
  /** Pin roundness instead of drawing it at random. */
  roundness?: number;
  /** Scale how eventful the result is: gaps, extra ribbons, weight variation. */
  wildness?: number;
}

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

export const randomRecipe = (rand: () => number, bias: RecipeBias = {}): SlideRecipe => {
  const wildness = bias.wildness ?? 0.5;
  return {
    roundness: bias.roundness ?? rand(),
    complexity: lerp(0.15, 1, rand()),
    thickness: lerp(0.08, 0.3, rand()),
    thicknessVariation: rand() * wildness,
    // Most slides are intact; breakup should be an occasional character, not
    // the norm, or every result sounds like a fault.
    breakup: rand() < 0.35 * wildness ? lerp(0.15, 0.8, rand()) : 0,
    ribbons: rand() < 0.3 * wildness ? (rand() < 0.5 ? 2 : 3) : 1,
  };
};

/**
 * The top edge of one stroke, as a periodic contour in -1..1.
 *
 * Built from harmonics with random phases so it joins itself at the wrap — a
 * cycle that does not close would click once per period. `roundness` sets the
 * spectral tilt: steep falloff keeps the low partials and sounds soft, shallow
 * falloff keeps the high ones and sounds harsh.
 */
const strokeContour = (
  recipe: SlideRecipe,
  rand: () => number,
  width: number,
): Float32Array => {
  const tilt = lerp(0.45, 2.8, recipe.roundness);
  const partials = Math.max(1, Math.round(lerp(1, 9, recipe.complexity)));
  const phases = Array.from({ length: partials }, () => rand() * Math.PI * 2);
  // Drop the occasional partial so the spectrum is not a smooth ramp; hand
  // painting does not produce textbook harmonic series.
  const gains = Array.from({ length: partials }, (_, i) =>
    (rand() < 0.85 ? 1 : 0.15) / Math.pow(i + 1, tilt),
  );

  const out = new Float32Array(width);
  let peak = 1e-9;
  for (let x = 0; x < width; x++) {
    const t = x / width;
    let v = 0;
    for (let k = 0; k < partials; k++) {
      v += gains[k]! * Math.sin(2 * Math.PI * (k + 1) * t + phases[k]!);
    }
    out[x] = v;
    peak = Math.max(peak, Math.abs(v));
  }
  // Leave headroom so a thick stroke still fits inside the glass.
  const scale = 0.72 / peak;
  for (let x = 0; x < width; x++) out[x]! *= scale;
  return out;
};

/** Smooth periodic noise in 0-1, for weight variation along a stroke. */
const wobble = (rand: () => number, width: number, octaves = 3): Float32Array => {
  const out = new Float32Array(width);
  for (let o = 0; o < octaves; o++) {
    const freq = 1 + o * 2;
    const phase = rand() * Math.PI * 2;
    const amp = 1 / (o + 1);
    for (let x = 0; x < width; x++) {
      out[x]! += amp * Math.sin(2 * Math.PI * freq * (x / width) + phase);
    }
  }
  for (let x = 0; x < width; x++) out[x] = (out[x]! + 1.8) / 3.6;
  return out;
};

/**
 * Render a recipe into an opacity field, row 0 at the top.
 *
 * Gaps are painted as *thin* enamel rather than bare glass wherever possible.
 * Partial opacity still reads as dark to the photocell, so the loop keeps lock
 * but sits at a shifted equilibrium — which is a far more interesting sound
 * than the hard dropout a clean hole produces.
 */
export const paintSlideField = (
  recipe: SlideRecipe,
  rand: () => number,
  width = SLIDE_WIDTH,
  height = SLIDE_HEIGHT,
): Float32Array => {
  const field = new Float32Array(width * height);
  const ribbons = Math.max(1, Math.min(3, Math.round(recipe.ribbons)));

  for (let r = 0; r < ribbons; r++) {
    const contour = strokeContour(recipe, rand, width);
    const weight = wobble(rand, width);
    // Stack extra ribbons above the first, within reach of an overshoot.
    const offset = r === 0 ? 0 : lerp(0.3, 0.8, rand()) * (r % 2 === 0 ? -1 : 1);

    const baseRows = Math.max(3, recipe.thickness * height);

    for (let x = 0; x < width; x++) {
      const centre = (1 - (contour[x]! + offset + 1) / 2) * (height - 1);
      const rows = baseRows * lerp(1, weight[x]!, recipe.thicknessVariation);
      const top = Math.max(0, Math.round(centre));
      const bottom = Math.min(height - 1, Math.round(centre + rows));
      for (let y = top; y <= bottom; y++) {
        // Slight mottling: hand-applied enamel is not uniformly opaque.
        field[y * width + x] = Math.min(1, 0.88 + rand() * 0.2);
      }
    }
  }

  if (recipe.breakup > 0) applyBreakup(field, recipe, rand, width, height);
  return field;
};

/** Thin or erase short stretches, the way worn enamel actually fails. */
const applyBreakup = (
  field: Float32Array,
  recipe: SlideRecipe,
  rand: () => number,
  width: number,
  height: number,
): void => {
  const count = Math.max(1, Math.round(recipe.breakup * 6));
  for (let g = 0; g < count; g++) {
    const centre = rand() * width;
    /*
     * Mostly thin enamel, occasionally bare glass.
     *
     * The threshold matters more than it looks. The loop rests where
     * transmitted light equals its reference, so paint above about half opacity
     * still holds lock and merely shifts the equilibrium — a scratch you hear
     * as roughness. Below that the spot loses the edge, dives to the rail, and
     * the DC blocker removes it: the stroke stops making a tone and starts
     * making sputter. Heavy breakup used to leave slides fourteen times quieter
     * than their neighbours, which made the randomiser produce duds.
     */
    const bare = rand() < 0.15;
    const floor = bare ? 0 : lerp(0.7, 0.9, rand());
    // A hole right through to the glass has to be narrow. The spot falls to the
    // rail while it crosses one, and the DC blocker removes that, so a wide
    // hole does not sound rough — it goes quiet. Kept brief it reads as a
    // scratch; left wide it left slides eight times quieter than their
    // neighbours and the randomiser produced duds.
    const halfSpan = (bare ? lerp(0.002, 0.008, rand()) : lerp(0.006, 0.05, rand())) * width;

    const from = Math.floor(centre - halfSpan);
    const to = Math.ceil(centre + halfSpan);
    for (let i = from; i <= to; i++) {
      const x = ((i % width) + width) % width;
      // Feather the ends so the stroke thins into the gap rather than
      // stopping dead, which is what the loop hears as a scratch.
      const edge = 1 - Math.abs(i - centre) / halfSpan;
      const strength = Math.max(0, Math.min(1, edge * 1.6));
      const factor = lerp(1, floor, strength);
      for (let y = 0; y < height; y++) field[y * width + x]! *= factor;
    }
  }
};

/** Convenience: a whole slide from a seed. */
export const randomSlideField = (
  seed: number,
  bias?: RecipeBias,
  width = SLIDE_WIDTH,
  height = SLIDE_HEIGHT,
): { field: Float32Array; recipe: SlideRecipe } => {
  const rand = mulberry32(seed);
  const recipe = randomRecipe(rand, bias);
  return { field: paintSlideField(recipe, rand, width, height), recipe };
};

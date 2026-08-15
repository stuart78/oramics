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
  /**
   * Peak-to-peak rise and fall of the top edge, as a fraction of the glass.
   *
   * This is the one dimension that is not free. The spot's vertical excursion
   * *is* the waveform, so swing sets output level directly. A slide drawn at a
   * quarter the swing of its neighbour disappears when four timbres are summed,
   * which is why the range here is deliberately narrow.
   */
  swing: number;
  /** Where the stroke sits on the glass, 0 low and 1 high. */
  placement: number;
  /** Periodic phase distortion, 0 symmetric and 1 heavily skewed. */
  warp: number;
  /** Stroke weight, 0-1 of the available height. */
  thickness: number;
  /** How much the stroke varies in weight along its length. 0-1. */
  thicknessVariation: number;
  /** Thin and broken enamel — gaps the spot can fall through. 0-1. */
  breakup: number;
  /** Blobs of heavy enamel, sitting on the stroke or floating over it. 0-3. */
  splotches: number;
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

/**
 * The thinnest ribbon the servo can hold, as a fraction of the glass.
 *
 * Not a drawing decision. Measured: sweeping thickness against swing and
 * complexity, output level is flat from about a tenth of the height upward and
 * falls off a cliff below it, to a quarter of the level at 0.06 and a seventh
 * at 0.04. A thin ribbon gives the loop nothing to fall back into — an
 * overshoot on a steep flank carries the spot clean past the paint and there is
 * no dark region left to recapture it. Oram's own ribbons are thick, and this
 * is why. Slides below the floor were the duds in the randomiser.
 */
const MIN_THICKNESS = 0.1;

export const randomRecipe = (rand: () => number, bias: RecipeBias = {}): SlideRecipe => {
  const wildness = bias.wildness ?? 0.5;
  return {
    roundness: bias.roundness ?? rand(),
    complexity: lerp(0.15, 1, rand()),
    swing: lerp(0.5, 0.92, rand()),
    placement: rand(),
    // Most strokes are skewed. A brush loaded at one end of a sweep does not
    // lay down a symmetric curve, and symmetry is a large part of why a
    // generated slide reads as a sine.
    warp: rand() < 0.7 ? lerp(0.1, 0.85, rand()) : 0,
    thickness: lerp(MIN_THICKNESS, 0.34, rand()),
    thicknessVariation: rand() * wildness,
    // Most slides are intact; breakup should be an occasional character, not
    // the norm, or every result sounds like a fault.
    breakup: rand() < 0.35 * wildness ? lerp(0.15, 0.8, rand()) : 0,
    splotches: rand() < 0.55 ? 1 + Math.floor(rand() * 3) : 0,
    ribbons: rand() < 0.3 * wildness ? (rand() < 0.5 ? 2 : 3) : 1,
  };
};

/**
 * The top edge of one stroke, as a periodic contour normalised to -1..1.
 *
 * Built from harmonics with random phases so it joins itself at the wrap — a
 * cycle that does not close would click once per period. `roundness` sets the
 * spectral tilt: steep falloff keeps the low partials and sounds soft, shallow
 * falloff keeps the high ones and sounds harsh.
 *
 * Two things stop the result being a sine with a wobble on it. The fundamental
 * is randomly weakened, which lets a middle partial lead and grows the stroke
 * extra lobes per cycle. And the time axis is warped by a periodic function
 * before the sum is evaluated, which slides the peak off centre and steepens
 * one flank against the other. Both keep the cycle closed, so neither adds the
 * once-per-period click that an open cycle would.
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
  if (partials > 1) gains[0]! *= lerp(0.2, 1, rand());

  // Held under 1 so the warped time axis stays monotonic. Past that the contour
  // doubles back on itself, which reads as a fold rather than a brush stroke.
  const warp = Math.min(0.9, recipe.warp) / (2 * Math.PI);
  const warpPhase = rand() * Math.PI * 2;

  const out = new Float32Array(width);
  let peak = 1e-9;
  let power = 0;
  for (let x = 0; x < width; x++) {
    const t = x / width;
    const tw = t + warp * Math.sin(2 * Math.PI * t + warpPhase);
    let v = 0;
    for (let k = 0; k < partials; k++) {
      v += gains[k]! * Math.sin(2 * Math.PI * (k + 1) * tw + phases[k]!);
    }
    out[x] = v;
    power += v * v;
    peak = Math.max(peak, Math.abs(v));
  }

  /*
   * Normalise on the body of the stroke, not on its tallest point.
   *
   * Dividing by the peak means one narrow spike sets the scale for the whole
   * contour, and the rest of the cycle ends up a fraction of the height it
   * could have used. Since the spot's excursion is the waveform, that slide
   * comes out several times quieter than its neighbours while looking normal —
   * it was the last dud left in the generator. So the scale comes from the rms
   * where the contour is peaky, and anything past the glass is clamped, which
   * is what a stroke painted off the top of the slide would do anyway.
   */
  const rms = Math.sqrt(power / width);
  const norm = Math.max(1e-9, Math.min(peak, rms * CREST));
  for (let x = 0; x < width; x++) {
    const v = out[x]! / norm;
    out[x] = v < -1 ? -1 : v > 1 ? 1 : v;
  }
  return out;
};

/** Crest factor allowed before the contour is scaled on its rms instead. A sine is 1.41. */
const CREST = 2.2;

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

  const swing = Math.max(0.05, Math.min(0.94, recipe.swing));
  // Where the stroke can sit without running off the glass. A wide stroke has
  // almost no choice; a narrow one can sit anywhere, which is where most of the
  // visible variety between slides comes from.
  const room = MARGIN + swing / 2;
  const mid = room * 2 > 1 ? 0.5 : lerp(room, 1 - room, recipe.placement);

  for (let r = 0; r < ribbons; r++) {
    const contour = strokeContour(recipe, rand, width);
    const weight = wobble(rand, width);
    // Stack extra ribbons clear of the first, within reach of an overshoot.
    const offset = r === 0 ? 0 : lerp(0.15, 0.4, rand()) * (r % 2 === 0 ? -1 : 1);
    const ribbonMid = Math.max(MARGIN, Math.min(1 - MARGIN, mid + offset));

    const floor = MIN_THICKNESS * height;
    const baseRows = Math.max(floor, recipe.thickness * height);

    for (let x = 0; x < width; x++) {
      // Row 0 is the top of the glass, so a high edge is a low row number.
      const centre = (1 - (ribbonMid + (contour[x]! * swing) / 2)) * (height - 1);
      // Weight varies down to the floor and no further: a stroke that thins
      // past it stops sounding rather than sounding thinner.
      const rows = Math.max(floor, baseRows * lerp(1, weight[x]!, recipe.thicknessVariation));
      const top = Math.max(0, Math.round(centre));
      const bottom = Math.min(height - 1, Math.round(centre + rows));
      for (let y = top; y <= bottom; y++) {
        // Slight mottling: hand-applied enamel is not uniformly opaque.
        field[y * width + x] = Math.min(1, 0.88 + rand() * 0.2);
      }
    }
  }

  if (recipe.splotches > 0) addSplotches(field, recipe, rand, width, height);
  if (recipe.breakup > 0) applyBreakup(field, recipe, rand, width, height);
  return field;
};

/** Clear glass kept above and below the stroke, as a fraction of the height. */
const MARGIN = 0.04;

/** Row of the first painted pixel in a column, or -1 for bare glass. */
const topRow = (field: Float32Array, x: number, width: number, height: number): number => {
  for (let y = 0; y < height; y++) if (field[y * width + x]! >= 0.5) return y;
  return -1;
};

/**
 * Blobs of heavy enamel, the kind a loaded brush leaves at the end of a sweep.
 *
 * Most sit on the stroke and bulge its top edge upward, which the spot rides
 * over as a swell in the cycle. A few float clear of it, and those are the more
 * interesting ones: the spot is only locally stable, so a blob overhead is a
 * second edge it can jump to and fall off again, which is where the irregular
 * cycle-to-cycle behaviour on Oram's own slides comes from.
 *
 * They wrap in x. A blob crossing the seam has to appear at both ends or the
 * cycle stops closing and the slide clicks once per period.
 */
const addSplotches = (
  field: Float32Array,
  recipe: SlideRecipe,
  rand: () => number,
  width: number,
  height: number,
): void => {
  const count = Math.max(0, Math.min(3, Math.round(recipe.splotches)));
  for (let s = 0; s < count; s++) {
    const cx = rand() * width;
    const rx = lerp(0.03, 0.13, rand()) * width;
    const ry = lerp(0.07, 0.24, rand()) * height;

    const edge = topRow(field, ((Math.floor(cx) % width) + width) % width, width, height);
    const detached = rand() < 0.3;
    let cy: number;
    if (edge < 0) cy = lerp(0.2, 0.8, rand()) * height;
    else if (detached) cy = edge - ry * lerp(1.7, 2.8, rand());
    // Sunk into the stroke rather than balanced on it, so the join reads as one
    // mass of enamel instead of a circle stuck to a line.
    else cy = edge + ry * 0.4;

    // An ellipse with a few lobes on its rim: round enough to be a blob, uneven
    // enough not to look drawn by a compass.
    const lobes = 2 + Math.floor(rand() * 4);
    const lobePhase = rand() * Math.PI * 2;
    const lobeDepth = lerp(0.1, 0.4, rand());

    const span = Math.ceil(rx);
    for (let i = -span; i <= span; i++) {
      const u = i / rx;
      if (u < -1 || u > 1) continue;
      const x = ((Math.round(cx + i) % width) + width) % width;
      const half =
        ry * Math.sqrt(Math.max(0, 1 - u * u)) * (1 + lobeDepth * Math.sin(lobes * u + lobePhase));
      const from = Math.max(0, Math.round(cy - half));
      const to = Math.min(height - 1, Math.round(cy + half));
      for (let y = from; y <= to; y++) field[y * width + x] = Math.min(1, 0.9 + rand() * 0.15);
    }
  }
};

/** Thin or erase short stretches, the way worn enamel actually fails. */
const applyBreakup = (
  field: Float32Array,
  recipe: SlideRecipe,
  rand: () => number,
  width: number,
  height: number,
): void => {
  /*
   * Gaps are collected into one factor per column and applied at the end,
   * taking the thinnest rather than multiplying.
   *
   * Multiplying compounds: four overlapping gaps at 0.7 each leave 0.24, which
   * is under the loop's lock threshold, so the spot dives and the DC blocker
   * removes it. That is how a heavily broken slide ended up fifteen times
   * quieter than its neighbours. Enamel does not get thinner because two
   * scratches happen to cross; the thinnest point is what the spot sees.
   */
  const factors = new Float32Array(width).fill(1);

  const count = Math.max(1, Math.round(recipe.breakup * 6));
  for (let g = 0; g < count; g++) {
    const centre = rand() * width;
    /*
     * Thin enamel, never bare glass.
     *
     * The threshold matters more than it looks. The loop rests where
     * transmitted light equals its reference, so paint above about half opacity
     * still holds lock and merely shifts the equilibrium — a scratch you hear
     * as roughness, which is the whole point of breakup. Below that the spot
     * loses the edge and dives to the rail, and the recovery costs far more
     * than the width of the hole: one hole three columns wide out of 512 left a
     * slide seven times quieter than its neighbours, contour pinned to the
     * bottom rail. Holes right through were the last dud in the generator.
     *
     * The engine still models bare glass, because the machine does that and
     * `scanner.test.ts` pins the behaviour. It is the randomiser that has no
     * business rolling one at random.
     */
    const floor = lerp(0.65, 0.9, rand());
    // Capped width for the opposite reason. Thin paint pulls the resting point
    // down into the stroke, so over a wide stretch it flattens the contour
    // rather than roughening it, and a slide with half its cycle thinned came
    // out several times quieter while looking perfectly healthy.
    const halfSpan = lerp(0.006, 0.028, rand()) * width;

    const from = Math.floor(centre - halfSpan);
    const to = Math.ceil(centre + halfSpan);
    for (let i = from; i <= to; i++) {
      const x = ((i % width) + width) % width;
      // Feather the ends so the stroke thins into the gap rather than
      // stopping dead, which is what the loop hears as a scratch.
      const edge = 1 - Math.abs(i - centre) / halfSpan;
      const strength = Math.max(0, Math.min(1, edge * 1.6));
      factors[x] = Math.min(factors[x]!, lerp(1, floor, strength));
    }
  }

  for (let x = 0; x < width; x++) {
    const factor = factors[x]!;
    if (factor >= 1) continue;
    for (let y = 0; y < height; y++) field[y * width + x]! *= factor;
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

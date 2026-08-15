/**
 * Splitting a lane into the runs that get drawn as connected lines.
 *
 * Shared so the editor pad and the projector agree. They used to disagree: the
 * projector drew one polyline through the whole array, NaN and all, which the
 * canvas silently swallowed into a path nobody could predict.
 */

/**
 * A step this large between neighbouring columns is a seam, not a slope.
 *
 * Only used where the stroke ids cannot answer the question, which means data
 * that came from a scan. A real gesture interpolates across its own span, so it
 * cannot produce a jump this steep in one column, but two unrelated marks that
 * happen to abut can.
 */
const BREAK = 0.35;

export interface Runs {
  values: Float32Array;
  /** Stroke id per column. 0 means unknown, and falls back to the slope test. */
  strokes?: Int32Array;
  /** Restrict to a column range, for a zoomed view. Inclusive. */
  from?: number;
  to?: number;
}

/**
 * Call `visit` once per unbroken run, with inclusive column bounds.
 *
 * Three things end a run. Undrawn stretches are NaN and must stay blank, since
 * bridging them would draw a line nobody drew and a scanned sheet is mostly
 * blank paper. A change of stroke id ends one, which is what stops a fresh mark
 * from being absorbed into whatever was underneath it. And where neither side
 * carries an id, an implausibly steep step ends one.
 */
export const eachRun = (opts: Runs, visit: (from: number, to: number) => void): void => {
  const { values, strokes } = opts;
  const first = Math.max(0, opts.from ?? 0);
  const last = Math.min(values.length - 1, opts.to ?? values.length - 1);

  let start = -1;
  for (let i = first; i <= last; i++) {
    if (!Number.isFinite(values[i]!)) {
      if (start >= 0) visit(start, i - 1);
      start = -1;
      continue;
    }
    if (start < 0) {
      start = i;
      continue;
    }

    const here = strokes?.[i] ?? 0;
    const before = strokes?.[i - 1] ?? 0;
    const broken =
      here !== before || (here === 0 && Math.abs(values[i]! - values[i - 1]!) > BREAK);
    if (broken) {
      visit(start, i - 1);
      start = i;
    }
  }
  if (start >= 0) visit(start, last);
};

/** The next unused stroke id for a lane. Ids only have to be locally distinct. */
export const nextStrokeId = (strokes: Int32Array): number => {
  let top = 0;
  for (let i = 0; i < strokes.length; i++) if (strokes[i]! > top) top = strokes[i]!;
  return top + 1;
};

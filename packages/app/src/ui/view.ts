/**
 * The visible slice of the timeline, shared by every lane.
 *
 * All ten strips ran off the same transport, so they zoom together. A view is
 * two fractions of the 30 s field, and the whole sheet is 0 to 1.
 */

export interface View {
  from: number;
  to: number;
}

export const FULL: View = { from: 0, to: 1 };

/**
 * Closest in you can go, as a fraction of the sheet.
 *
 * 30 ms of the field, which is three of the 3000 columns a lane holds. Past
 * that you are looking at the sampling grid rather than at a drawing.
 */
const MIN_SPAN = 0.001;

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

/** Slide the window without changing how much it shows, stopping at the ends. */
export const panBy = (view: View, delta: number): View => {
  const span = view.to - view.from;
  const from = clamp(view.from + delta, 0, 1 - span);
  return { from, to: from + span };
};

/**
 * Zoom about a fixed point, given as a fraction of the window's width.
 *
 * Anchoring on the pointer rather than the centre is what makes wheel zoom feel
 * like the view is attached to the drawing: whatever is under the cursor stays
 * under the cursor.
 */
export const zoomAt = (view: View, anchor: number, factor: number): View => {
  const span = view.to - view.from;
  const next = clamp(span * factor, MIN_SPAN, 1);
  const at = view.from + span * clamp(anchor, 0, 1);
  const from = clamp(at - next * clamp(anchor, 0, 1), 0, 1 - next);
  return { from, to: from + next };
};

/** Keep a position in shot, scrolling by pages rather than creeping along. */
export const follow = (view: View, at: number): View => {
  const span = view.to - view.from;
  if (span >= 1) return view;
  if (at >= view.from + span * 0.08 && at <= view.to - span * 0.08) return view;
  return panBy({ from: 0, to: span }, at - span * 0.15);
};

/**
 * Grid spacing in seconds, chosen so a zoomed view stays readable.
 *
 * Fixed one-second lines turn into a solid block at 30x, and at full zoom-out a
 * finer grid would too. The ladder keeps somewhere around ten to thirty lines
 * on screen at every zoom level.
 */
export const gridStep = (secondsVisible: number): number => {
  for (const step of [0.01, 0.02, 0.05, 0.1, 0.25, 0.5, 1, 2, 5]) {
    if (secondsVisible / step <= 30) return step;
  }
  return 10;
};

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { eachRun, nextStrokeId } from './runs.js';
import { FULL, follow, gridStep, panBy, zoomAt } from './view.js';

/** Collect the runs a lane splits into, as inclusive column ranges. */
const runsOf = (values: number[], strokes?: number[]): [number, number][] => {
  const out: [number, number][] = [];
  eachRun(
    {
      values: Float32Array.from(values),
      ...(strokes ? { strokes: Int32Array.from(strokes) } : {}),
    },
    (from, to) => out.push([from, to]),
  );
  return out;
};

const N = Number.NaN;

// --- runs ------------------------------------------------------------------

test('blank stretches break a run', () => {
  assert.deepEqual(runsOf([N, 0.2, 0.3, N, N, 0.9, 0.9]), [
    [1, 2],
    [5, 6],
  ]);
});

test('a fresh stroke over an old line does not extend it', () => {
  /*
   * The case that kept coming back. A lane holds one value per column, so the
   * second stroke necessarily replaces what the first left there. Without the
   * ids, columns 2 and 3 differ by less than the slope test allows and the two
   * marks get drawn as one continuous line, which reads as the old line having
   * grown rather than as a new mark sitting on top of it.
   */
  const values = [0.5, 0.5, 0.5, 0.45, 0.45, 0.5, 0.5];
  const strokes = [1, 1, 1, 2, 2, 1, 1];
  assert.deepEqual(runsOf(values, strokes), [
    [0, 2],
    [3, 4],
    [5, 6],
  ]);
  // Same values, no record of who drew what: one line, as before.
  assert.deepEqual(runsOf(values), [[0, 6]]);
});

test('a steep step still breaks a run where nothing knows better', () => {
  // Scanned sheets arrive with no stroke ids at all, so the slope test has to
  // keep working for them.
  assert.deepEqual(runsOf([0.1, 0.12, 0.9, 0.92], [0, 0, 0, 0]), [
    [0, 1],
    [2, 3],
  ]);
});

test('a real slope inside one stroke is left alone', () => {
  // Steeper than the slope test allows, but the ids say it is one gesture.
  assert.deepEqual(runsOf([0.05, 0.5, 0.95], [4, 4, 4]), [[0, 2]]);
});

test('only the visible columns are walked', () => {
  assert.deepEqual(
    runsOf(Array.from({ length: 100 }, () => 0.5)).length,
    1,
  );
  const out: [number, number][] = [];
  eachRun(
    { values: Float32Array.from(Array.from({ length: 100 }, () => 0.5)), from: 20, to: 30 },
    (from, to) => out.push([from, to]),
  );
  assert.deepEqual(out, [[20, 30]]);
});

test('a new stroke id clears the ones already used', () => {
  assert.equal(nextStrokeId(Int32Array.from([0, 0, 3, 3, 1])), 4);
  assert.equal(nextStrokeId(new Int32Array(10)), 1);
});

// --- view ------------------------------------------------------------------

test('zoom keeps the anchor under the pointer', () => {
  const zoomed = zoomAt({ from: 0, to: 1 }, 0.25, 0.5);
  assert.ok(Math.abs(zoomed.from + (zoomed.to - zoomed.from) * 0.25 - 0.25) < 1e-9);
});

test('the view never runs off either end', () => {
  assert.deepEqual(panBy({ from: 0.9, to: 1 }, 0.5), { from: 0.9, to: 1 });
  assert.deepEqual(panBy({ from: 0, to: 0.1 }, -0.5), { from: 0, to: 0.1 });
  const wide = zoomAt(FULL, 0.5, 4);
  assert.deepEqual(wide, FULL, 'zooming out past the whole sheet');
});

test('following the head pages rather than creeping', () => {
  const window = { from: 0.2, to: 0.3 };
  // Unchanged by identity, so a meter tick thirty times a second does not
  // re-render every lane while the head is comfortably in shot.
  assert.equal(follow(window, 0.25), window);
  const moved = follow(window, 0.31);
  assert.ok(moved.from > window.from, 'did not move on');
  assert.ok(0.31 > moved.from && 0.31 < moved.to, 'head ended up outside anyway');
  assert.ok(Math.abs(moved.to - moved.from - 0.1) < 1e-9, 'zoom level changed');
});

test('the grid thins out as you zoom', () => {
  assert.ok(gridStep(30) >= 1, 'whole sheet should not draw a line per 100 ms');
  assert.ok(gridStep(1) < 0.1, 'one second on screen should show more than a line per second');
  assert.ok(gridStep(0.5) < gridStep(30));
});

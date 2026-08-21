import assert from 'node:assert/strict';
import { test } from 'node:test';

import { hasRasteriser, renderSheet } from '@oramics/vision/fixture';
import { importSheet } from '@oramics/vision';

import { LANE_SAMPLES, SLIDE_HEIGHT, SLIDE_WIDTH } from './lanes.js';
import { isBlank, toSession } from './scan.js';

const skip = hasRasteriser() ? false : 'pdftoppm is not installed';
const COLUMNS = 600;

const drawnShape = (): Float32Array => {
  const out = new Float32Array(COLUMNS);
  for (let i = 0; i < COLUMNS; i++) {
    const t = i / (COLUMNS - 1);
    out[i] = t < 0.15 || t > 0.85 ? Number.NaN : 0.5 + 0.28 * Math.sin(2 * Math.PI * (t - 0.15));
  }
  return out;
};

test('a scanned sheet lands in the session as ordinary lanes', { skip }, async () => {
  const want = drawnShape();
  const sheet = await renderSheet(200, { PCH: want, AMP1: want });
  const scan = toSession(importSheet(sheet, { laneColumns: COLUMNS, slideWidth: SLIDE_WIDTH, slideHeight: SLIDE_HEIGHT }));

  assert.equal(scan.sheetId, 'A3F91C2D');
  assert.equal(scan.durationS, 30);
  assert.ok(!isBlank(scan), 'the sheet had marks on it');

  const { values, strokes } = scan.lanes.pitch;
  assert.equal(values.length, LANE_SAMPLES, 'lanes come back at the app resolution');

  // Blank paper stays blank, which is the distinction the lane model rests on.
  assert.ok(Number.isNaN(values[0]!), 'the blank left margin came back as a value');
  assert.equal(strokes[0], 0, 'blank paper was given a stroke');

  const middle = values[Math.round(LANE_SAMPLES / 2)]!;
  assert.ok(Number.isFinite(middle), 'the drawn middle came back blank');
  assert.ok(strokes[Math.round(LANE_SAMPLES / 2)]! > 0, 'the drawn middle has no stroke');

  // One unbroken mark with blank paper either side is one stroke.
  const ids = new Set([...strokes].filter((s) => s > 0));
  assert.equal(ids.size, 1, `expected one stroke, got ${ids.size}`);
});

test('an untouched sheet imports as untouched', { skip }, async () => {
  const scan = toSession(importSheet(await renderSheet(200), { laneColumns: COLUMNS }));
  assert.ok(isBlank(scan), `blank sheet reported marks: ${JSON.stringify(scan.coverage)}`);
});

test('timbre panels come back as fields the scanner can lock onto', { skip }, async () => {
  const panel = new Float32Array(256);
  for (let i = 0; i < panel.length; i++) {
    panel[i] = 0.5 + 0.3 * Math.sin((2 * Math.PI * i) / panel.length);
  }
  const sheet = await renderSheet(200, { WAV1: panel });
  const scan = toSession(importSheet(sheet, { slideWidth: SLIDE_WIDTH, slideHeight: SLIDE_HEIGHT }));

  const field = scan.slides[0]!;
  assert.equal(field.length, SLIDE_WIDTH * SLIDE_HEIGHT);

  // A field, not a silhouette: the panel comes back as painted glass, so every
  // column carries something for the spot to ride.
  for (let x = 8; x < SLIDE_WIDTH - 8; x += 16) {
    let painted = 0;
    for (let y = 0; y < SLIDE_HEIGHT; y++) if (field[y * SLIDE_WIDTH + x]! > 0.5) painted++;
    assert.ok(painted > 0, `column ${x} came back as bare glass`);
  }
});

test('a scribbled panel keeps its detail instead of becoming a silhouette', { skip }, async () => {
  /*
   * The failure this replaced: reading each panel as one height per column and
   * filling below it. A workshop panel is not a tidy waveform. It is a scribble,
   * a word, a face, and every one of those came back as the same solid black
   * shape. Oram's slides were painted glass and the flying spot answers to the
   * whole field, so the field is what the panel has to become.
   */
  const sheet = await renderSheet(200);
  const scan = toSession(importSheet(sheet, { slideWidth: SLIDE_WIDTH, slideHeight: SLIDE_HEIGHT }));
  const field = scan.slides[0]!;

  // An empty panel keeps its printed centre rail and nothing else, so most of
  // the glass is clear. A silhouette would have filled half of it.
  let opaque = 0;
  for (const v of field) if (v > 0.5) opaque++;
  assert.ok(opaque / field.length < 0.15, `${((opaque / field.length) * 100).toFixed(0)}% of blank glass came back painted`);
});

test('a photograph of something else is refused with a reason', () => {
  const noise = new Float32Array(400 * 300);
  for (let i = 0; i < noise.length; i++) noise[i] = 0.5 + Math.sin(i) * 0.02;

  const result = importSheet({ data: noise, width: 400, height: 300 });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, 'no-fiducials');
  assert.match(result.message, /corner/i);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { randomSlideField } from '@oramics/engine';
import { PDFDocument } from 'pdf-lib';

import { buildSessionPdf } from './export.js';
import { LANE_DEFS, LANE_SAMPLES, makeAllLanes, type LaneMap } from './lanes.js';

const LEGAL_LANDSCAPE = { widthMm: 14 * 25.4, heightMm: 8.5 * 25.4 };
const PT_PER_MM = 72 / 25.4;

/** A session with a shape drawn in every band and four painted slides. */
const drawnOnEverything = (): { lanes: LaneMap; slides: Float32Array[] } => {
  const lanes = makeAllLanes();
  LANE_DEFS.forEach((def, i) => {
    const { values, strokes } = lanes[def.name];
    for (let k = 200; k < LANE_SAMPLES - 200; k++) {
      values[k] = 0.5 + 0.4 * Math.sin(2 * Math.PI * (k / LANE_SAMPLES) * (i + 1));
      strokes[k] = 1;
    }
  });
  return { lanes, slides: Array.from({ length: 4 }, (_, i) => randomSlideField(i + 3).field) };
};

test('a session exports to exactly one Legal page', async () => {
  // The whole point of the sheet: one page to print, one page to scan back.
  // It used to be two, with the timbres on their own.
  const { lanes, slides } = drawnOnEverything();
  const doc = await PDFDocument.load(await buildSessionPdf({ lanes, slides, sheetId: 'BEEF1234' }));

  assert.equal(doc.getPageCount(), 1);
  const { width, height } = doc.getPage(0).getSize();
  assert.ok(Math.abs(width - LEGAL_LANDSCAPE.widthMm * PT_PER_MM) < 0.5, `page is ${width} pt wide`);
  assert.ok(Math.abs(height - LEGAL_LANDSCAPE.heightMm * PT_PER_MM) < 0.5, `page is ${height} pt tall`);
});

test('an empty session still exports one page', async () => {
  const doc = await PDFDocument.load(
    await buildSessionPdf({
      lanes: makeAllLanes(),
      slides: Array.from({ length: 4 }, () => new Float32Array(512 * 256)),
      sheetId: 'BEEF1234',
    }),
  );
  assert.equal(doc.getPageCount(), 1);
});

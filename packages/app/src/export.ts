/**
 * Export the current session as the same printable sheet contributors draw on.
 *
 * Round trip: draw here, print it, someone marks it up by hand, scan it back.
 * That only works because the app and the printed template share one geometry
 * module — the overlay lands exactly on the band it came from.
 */

import {
  buildDocument,
  makeSheetId,
  sheetPayload,
  type Overlays,
  type Page,
} from '@oramics/template';

import { LANE_DEFS, SLIDE_HEIGHT, SLIDE_WIDTH, type LaneMap } from './lanes.js';

export interface ExportOptions {
  lanes: LaneMap;
  /** Painted slide opacity fields, one per timbre. */
  slides: Float32Array[];
  sheetId?: string;
  /** Leave bands blank where nothing was drawn, rather than printing the rest line. */
  omitUntouched?: boolean;
}

/**
 * Trace the top edge of each painted stroke — the line the scanner's spot
 * actually rides. The printed sheet shows that rather than the whole painted
 * mass, because the underside is inaudible and drawing it would mislead anyone
 * marking the sheet up by hand.
 */
const topEdge = (field: Float32Array, width: number, height: number): Float32Array => {
  const out = new Float32Array(width);
  for (let x = 0; x < width; x++) {
    let found = -1;
    for (let y = 0; y < height; y++) {
      if (field[y * width + x]! >= 0.5) {
        found = y;
        break;
      }
    }
    // Nothing painted: the spot would sit at the bottom rail.
    out[x] = found < 0 ? 0 : 1 - found / (height - 1);
  }
  return out;
};

/** A lane still sitting flat at its rest value was never drawn on. */
const isUntouched = (values: Float32Array, rest: number): boolean => {
  for (const v of values) if (Math.abs(v - rest) > 1e-4) return false;
  return true;
};

export const buildSessionPdf = async (opts: ExportOptions): Promise<Uint8Array> => {
  const sheetId = (opts.sheetId ?? makeSheetId()).toUpperCase();

  // Bands and timbres share one sheet, so they share one overlay map. The keys
  // do not collide: lanes are role ids, timbres are WAV1 to WAV4.
  const overlays: Overlays = {};
  for (const def of LANE_DEFS) {
    const { values } = opts.lanes[def.name];
    if (opts.omitUntouched !== false && isUntouched(values, def.rest)) continue;
    overlays[def.role] = values;
  }
  opts.slides.forEach((field, i) => {
    overlays[`WAV${i + 1}`] = topEdge(field, SLIDE_WIDTH, SLIDE_HEIGHT);
  });

  const pages: Page[] = [
    { kind: 'machine', options: { payload: sheetPayload(sheetId), overlays } },
  ];

  return buildDocument({ pages, title: `Daphne session — ${sheetId}` });
};

/**
 * The sheet with nothing on it, ready to print and hand out.
 *
 * The same page the app exports a session onto, so a piece drawn on paper and a
 * piece drawn on screen land on identical geometry and import the same way.
 */
export const buildBlankPdf = async (sheetId?: string): Promise<Uint8Array> => {
  const id = (sheetId ?? makeSheetId()).toUpperCase();
  return buildDocument({
    pages: [{ kind: 'machine', options: { payload: sheetPayload(id) } }],
    title: `Daphne sheet ${id}`,
  });
};

/** Hand a PDF to the shell to save, or fall back to a browser download. */
const save = async (bytes: Uint8Array, name: string): Promise<string | null> => {
  const shell = window.oramics;
  if (shell) return shell.savePdf(bytes, name);

  const blob = new Blob([bytes as BlobPart], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
  return name;
};

export const exportSessionPdf = async (opts: ExportOptions): Promise<string | null> =>
  save(await buildSessionPdf(opts), 'daphne-session.pdf');

export const exportBlankPdf = async (sheetId?: string): Promise<string | null> =>
  save(await buildBlankPdf(sheetId), 'daphne-sheet.pdf');

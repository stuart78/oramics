/**
 * Reading the sheet's own description of itself.
 *
 * The QR is what makes importing scan-and-drop rather than a form to fill in.
 * It carries the sheet id, the duration the field was drawn for and where that
 * field sits, so the app takes its speed from the paper instead of the operator
 * having to remember what the paper was printed for.
 *
 * It is decoded after registration, not before. Rectifying the symbol first
 * turns a QR photographed at an angle into a flat one, which is the difference
 * between a decode that works on a desk and one that works at a workshop table.
 */

import jsQR from 'jsqr';

import { decodePayload, qrRect, type SheetPayload } from '@oramics/template';

import type { Matrix3 } from './homography.js';
import type { Gray } from './image.js';
import { rectify } from './rectify.js';

/**
 * Decode the sheet payload, or null.
 *
 * Null is survivable: without it the importer falls back to the current
 * template's own geometry, which is right for a sheet printed by this build and
 * wrong for one printed by a later one. The caller decides whether to say so.
 */
export const readPayload = (image: Gray, toImage: Matrix3): SheetPayload | null => {
  const r = qrRect();
  // Take a margin around the symbol so the quiet zone comes with it, and
  // oversample: jsQR would rather have too many pixels per module than too few.
  const pad = 3;
  const box = { x: r.x - pad, y: r.y - pad, w: r.w + pad * 2, h: r.h + pad * 2 };

  for (const scale of [8, 12, 5]) {
    const flat = rectify(image, toImage, box, scale);
    const found = jsQR(flat.data, flat.width, flat.height, { inversionAttempts: 'dontInvert' });
    if (!found) continue;
    try {
      return decodePayload(found.data);
    } catch {
      // A QR that decodes but is not one of ours. Somebody photographed a sheet
      // with a sticker on it; keep looking rather than failing the import.
      continue;
    }
  }
  return null;
};

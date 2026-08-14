/**
 * Generate the app icon: a drawn wave crossed by the read head.
 *
 * Writes an RGBA PNG by hand rather than pulling in an image library. The only
 * hard requirement is real alpha — macOS icons need the rounded corners to be
 * transparent, and a flat square would look worse in the Dock than the default
 * Electron icon does. Everything else is a distance field and some smoothstep.
 *
 *   node scripts/make-icon.mjs
 *
 * electron-builder picks up build-resources/icon.png and produces the .icns.
 */

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SIZE = 1024;
const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '../packages/shell/build-resources');

// --- palette, matching the app -------------------------------------------
const BG = [0x14, 0x13, 0x17];
const GRID = [0x2e, 0x2b, 0x36];
const INK = [0xf2, 0xee, 0xe6];
const HEAD = [0xff, 0x7a, 0x4d];

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smoothstep = (edge0, edge1, x) => {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
};

/** Signed distance to a rounded rectangle, negative inside. */
const sdRoundRect = (px, py, cx, cy, hw, hh, r) => {
  const qx = Math.abs(px - cx) - (hw - r);
  const qy = Math.abs(py - cy) - (hh - r);
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
  return outside + Math.min(Math.max(qx, qy), 0) - r;
};

/**
 * The drawn contour, as a function of x in 0..1 returning y in 0..1 measured
 * from the top. A swell that rises and falls — the shape you get when someone
 * draws an amplitude lane for the first time.
 */
const curve = (t) =>
  0.5 - 0.32 * Math.sin(Math.PI * t) * Math.sin(2.6 * Math.PI * t + 0.4);

const pixels = Buffer.alloc(SIZE * SIZE * 4);

// macOS leaves a margin around the artwork; 824/1024 is the system proportion.
const inset = SIZE * 0.098;
const half = (SIZE - inset * 2) / 2;
const centre = SIZE / 2;
const radius = SIZE * 0.2237;

const strokeHalf = SIZE * 0.021;
const headX = 0.63;
const headHalf = SIZE * 0.0075;

for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    const px = x + 0.5;
    const py = y + 0.5;

    // Body mask, antialiased over one pixel.
    const d = sdRoundRect(px, py, centre, centre, half, half, radius);
    const bodyAlpha = 1 - smoothstep(-0.7, 0.7, d);
    if (bodyAlpha <= 0) continue;

    let r = BG[0];
    let g = BG[1];
    let b = BG[2];

    const t = (px - inset) / (half * 2);

    // Second lines, only inside the body.
    if (t >= 0 && t <= 1) {
      const gridT = t * 10;
      const gridD = Math.abs(gridT - Math.round(gridT)) * (half * 2) * 0.1;
      const gridA = (1 - smoothstep(0, 2.2, gridD)) * 0.9;
      r += (GRID[0] - r) * gridA;
      g += (GRID[1] - g) * gridA;
      b += (GRID[2] - b) * gridA;
    }

    // The contour. Perpendicular distance via the local slope, so the stroke
    // keeps an even weight on the steep parts.
    if (t >= -0.05 && t <= 1.05) {
      const ct = clamp01(t);
      const cy = inset + curve(ct) * half * 2;
      const eps = 1e-3;
      const slope = ((curve(clamp01(ct + eps)) - curve(clamp01(ct - eps))) * half * 2) / (2 * eps * half * 2);
      const dist = Math.abs(py - cy) / Math.hypot(1, slope);
      const a = 1 - smoothstep(strokeHalf - 1.2, strokeHalf + 1.2, dist);
      r += (INK[0] - r) * a;
      g += (INK[1] - g) * a;
      b += (INK[2] - b) * a;
    }

    // Read head.
    const hx = inset + headX * half * 2;
    const headA = 1 - smoothstep(headHalf - 1, headHalf + 1, Math.abs(px - hx));
    r += (HEAD[0] - r) * headA;
    g += (HEAD[1] - g) * headA;
    b += (HEAD[2] - b) * headA;

    const i = (y * SIZE + x) * 4;
    pixels[i] = r;
    pixels[i + 1] = g;
    pixels[i + 2] = b;
    pixels[i + 3] = Math.round(bodyAlpha * 255);
  }
}

// --- PNG container --------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // RGBA
ihdr[10] = 0; // deflate
ihdr[11] = 0; // adaptive filtering
ihdr[12] = 0; // no interlace

// Filter byte 0 (None) in front of every scanline.
const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 4 + 1)] = 0;
  pixels.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
}

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

mkdirSync(out, { recursive: true });
const file = join(out, 'icon.png');
writeFileSync(file, png);
console.log(`wrote ${file} (${SIZE}x${SIZE}, ${Math.round(png.length / 1024)} KB)`);

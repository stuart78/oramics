/**
 * A painted glass slide, painted.
 *
 * Oram's slides are thick irregular strokes of enamel on glass, not curves —
 * so this is a brush on an opacity field, not a line editor. Whatever you paint
 * is handed to the scanner exactly as a real slide would be, including the
 * ambiguous bits: a gap in a stroke really does drop the spot, and two ribbons
 * really do give the loop a choice.
 */

import { useCallback, useEffect, useRef, type JSX } from 'react';

import { hexToRgb, readPadPalette } from './palette.js';

export interface PaintPadProps {
  /** Opacity field, row 0 at the top, length width*height. */
  field: Float32Array;
  width: number;
  height: number;
  onChange: (field: Float32Array) => void;
  /** Brush radius in field pixels. */
  brush?: number;
  erasing?: boolean;
  /** Only a repaint trigger — the colours come from the CSS tokens. */
  theme?: string;
  displayHeight: number;
}

export const PaintPad = ({
  field,
  width,
  height,
  onChange,
  brush = 9,
  erasing = false,
  theme = 'dark',
  displayHeight,
}: PaintPadProps): JSX.Element => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const bufferRef = useRef<HTMLCanvasElement | null>(null);
  /** Reused across repaints — allocating 512 KB per pointer move is not free. */
  const imageRef = useRef<ImageData | null>(null);
  const drawing = useRef(false);
  const last = useRef<{ x: number; y: number } | null>(null);
  const fieldRef = useRef(field);
  fieldRef.current = field;

  const paint = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    if (!bufferRef.current) {
      bufferRef.current = document.createElement('canvas');
      bufferRef.current.width = width;
      bufferRef.current.height = height;
    }
    const buffer = bufferRef.current;
    const bctx = buffer.getContext('2d');
    if (!bctx) return;

    if (!imageRef.current) imageRef.current = bctx.createImageData(width, height);
    const image = imageRef.current;
    const data = image.data;
    const pal = readPadPalette();
    const BG = hexToRgb(pal.bg);
    const PAINT = hexToRgb(pal.ink);
    const f = fieldRef.current;
    for (let i = 0; i < width * height; i++) {
      const a = Math.max(0, Math.min(1, f[i]!));
      const o = i * 4;
      data[o] = BG[0] + (PAINT[0] - BG[0]) * a;
      data[o + 1] = BG[1] + (PAINT[1] - BG[1]) * a;
      data[o + 2] = BG[2] + (PAINT[2] - BG[2]) * a;
      data[o + 3] = 255;
    }
    bctx.putImageData(image, 0, 0);

    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
      canvas.width = w * dpr;
      canvas.height = h * dpr;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(buffer, 0, 0, w, h);
  }, [width, height, theme]);

  useEffect(() => {
    paint();
  }, [paint, field]);

  /** Stamp a soft disc, so strokes have the feathered edge enamel actually has. */
  const stamp = (f: Float32Array, cx: number, cy: number): void => {
    const r = brush;
    const x0 = Math.max(0, Math.floor(cx - r));
    const x1 = Math.min(width - 1, Math.ceil(cx + r));
    const y0 = Math.max(0, Math.floor(cy - r));
    const y1 = Math.min(height - 1, Math.ceil(cy + r));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const d = Math.hypot(x - cx, y - cy);
        if (d > r) continue;
        const a = Math.min(1, (1 - d / r) * 2.2);
        const i = y * width + x;
        f[i] = erasing ? Math.min(f[i]!, 1 - a) : Math.max(f[i]!, a);
      }
    }
  };

  const write = (event: React.PointerEvent<HTMLCanvasElement>): void => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const x = ((event.clientX - rect.left) / rect.width) * width;
    const y = ((event.clientY - rect.top) / rect.height) * height;

    const next = new Float32Array(fieldRef.current);
    const from = last.current;
    if (from) {
      // Interpolate along the drag so a fast stroke is continuous, not dotted.
      const steps = Math.max(1, Math.ceil(Math.hypot(x - from.x, y - from.y) / (brush * 0.4)));
      for (let s = 1; s <= steps; s++) {
        stamp(next, from.x + ((x - from.x) * s) / steps, from.y + ((y - from.y) * s) / steps);
      }
    } else {
      stamp(next, x, y);
    }
    last.current = { x, y };
    fieldRef.current = next;
    onChange(next);
  };

  return (
    <canvas
      ref={canvasRef}
      className="drawpad"
      style={{ height: displayHeight }}
      onPointerDown={(e) => {
        drawing.current = true;
        last.current = null;
        e.currentTarget.setPointerCapture(e.pointerId);
        write(e);
      }}
      onPointerMove={(e) => {
        if (drawing.current) write(e);
      }}
      onPointerUp={(e) => {
        drawing.current = false;
        last.current = null;
        e.currentTarget.releasePointerCapture(e.pointerId);
      }}
      onPointerCancel={() => {
        drawing.current = false;
        last.current = null;
      }}
    />
  );
};

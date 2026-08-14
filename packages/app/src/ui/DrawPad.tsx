/**
 * A drawable lane. Pointer input writes straight into a Float32Array of
 * normalised values, one per column, which is the same shape the extractor will
 * produce from a scanned sheet — so a drawn lane and a scanned lane are
 * indistinguishable downstream.
 */

import { useCallback, useEffect, useRef, type JSX } from 'react';

import { readPadPalette } from './palette.js';

export interface DrawPadProps {
  values: Float32Array;
  onChange: (values: Float32Array) => void;
  /** 0-1 position of the read head, or null to hide it. */
  head?: number | null;
  bipolar?: boolean;
  /** Fill solid below the line, the way Oram painted her film. */
  fill?: boolean;
  height: number;
  /** Horizontal guide lines, as 0-1 positions. */
  guides?: number[];
  /** Wipe columns back to blank instead of drawing on them. */
  erasing?: boolean;
  /** Only a repaint trigger — the colours come from the CSS tokens. */
  theme?: string;
  disabled?: boolean;
}

export const DrawPad = ({
  values,
  onChange,
  head = null,
  bipolar = false,
  fill = false,
  height,
  guides = [],
  erasing = false,
  theme = 'dark',
  disabled = false,
}: DrawPadProps): JSX.Element => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const lastIndex = useRef<number | null>(null);
  // Held in a ref so the render loop always sees the newest array without
  // re-subscribing every stroke.
  const valuesRef = useRef(values);
  valuesRef.current = values;

  const paint = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
      canvas.width = w * dpr;
      canvas.height = h * dpr;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const pal = readPadPalette();
    ctx.fillStyle = pal.bg;
    ctx.fillRect(0, 0, w, h);

    // One line per second, heavier every five.
    ctx.lineWidth = 1;
    for (let s = 1; s < 30; s++) {
      ctx.strokeStyle = s % 5 === 0 ? pal.guide : pal.grid;
      const x = Math.round((w * s) / 30) + 0.5;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
    }
    for (const g of guides) {
      ctx.strokeStyle = pal.grid;
      const y = Math.round(h * (1 - g)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    }
    if (bipolar) {
      ctx.strokeStyle = pal.guide;
      ctx.lineWidth = 1.5;
      const y = Math.round(h / 2) + 0.5;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    }

    const v = valuesRef.current;
    const n = v.length;
    const toX = (i: number): number => (i / (n - 1)) * w;
    const toY = (val: number): number => h * (1 - Math.max(0, Math.min(1, val)));

    /*
     * Walk the lane in runs of drawn samples.
     *
     * Two things end a run. Undrawn stretches are NaN and must stay blank —
     * bridging them would draw a line nobody drew, and a scanned sheet is
     * mostly blank paper. And a full-height step between two adjacent columns
     * ends one too: that only happens where a new stroke was laid over older
     * values, and joining them paints a vertical line through the lane that
     * nobody asked for. A stroke interpolates across its own span, so a real
     * gesture never produces a jump this steep in a single column.
     */
    const BREAK = 0.35;
    const eachRun = (visit: (from: number, to: number) => void): void => {
      let start = -1;
      for (let i = 0; i < n; i++) {
        const drawn = Number.isFinite(v[i]!);
        if (!drawn) {
          if (start >= 0) visit(start, i - 1);
          start = -1;
          continue;
        }
        if (start < 0) {
          start = i;
          continue;
        }
        if (Math.abs(v[i]! - v[i - 1]!) > BREAK) {
          visit(start, i - 1);
          start = i;
        }
      }
      if (start >= 0) visit(start, n - 1);
    };

    if (fill) {
      ctx.fillStyle = pal.fill;
      eachRun((from, to) => {
        if (to <= from) return;
        ctx.beginPath();
        ctx.moveTo(toX(from), h);
        for (let i = from; i <= to; i++) ctx.lineTo(toX(i), toY(v[i]!));
        ctx.lineTo(toX(to), h);
        ctx.closePath();
        ctx.fill();
      });
    }

    ctx.strokeStyle = pal.ink;
    ctx.lineWidth = 1.75;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    eachRun((from, to) => {
      ctx.beginPath();
      if (from === to) {
        // A single touched column still deserves a mark.
        ctx.moveTo(toX(from), toY(v[from]!));
        ctx.lineTo(toX(from) + 0.01, toY(v[from]!));
      } else {
        for (let i = from; i <= to; i++) {
          const y = toY(v[i]!);
          if (i === from) ctx.moveTo(toX(i), y);
          else ctx.lineTo(toX(i), y);
        }
      }
      ctx.stroke();
    });

    if (head !== null) {
      ctx.strokeStyle = pal.accent;
      ctx.lineWidth = 1.5;
      const x = Math.round(head * w) + 0.5;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
    }
  }, [bipolar, fill, guides, head, theme]);

  useEffect(() => {
    paint();
  }, [paint, values]);

  useEffect(() => {
    const onResize = (): void => paint();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [paint]);

  const write = (event: React.PointerEvent<HTMLCanvasElement>): void => {
    const canvas = canvasRef.current;
    if (!canvas || disabled) return;
    const rect = canvas.getBoundingClientRect();
    const n = valuesRef.current.length;
    const index = Math.max(
      0,
      Math.min(n - 1, Math.round(((event.clientX - rect.left) / rect.width) * (n - 1))),
    );
    const value = Math.max(0, Math.min(1, 1 - (event.clientY - rect.top) / rect.height));

    const next = new Float32Array(valuesRef.current);
    const from = lastIndex.current;

    if (erasing) {
      // A wider nib than the pen, so wiping is not fiddly.
      const nib = Math.max(2, Math.round(next.length * 0.008));
      const lo = Math.min(from ?? index, index) - nib;
      const hi = Math.max(from ?? index, index) + nib;
      for (let i = Math.max(0, lo); i <= Math.min(next.length - 1, hi); i++) {
        next[i] = Number.NaN;
      }
      lastIndex.current = index;
      valuesRef.current = next;
      onChange(next);
      return;
    }

    if (from === null || from === index) {
      next[index] = value;
    } else {
      // Fill in across a fast drag so one stroke is continuous. Only within
      // the stroke: lifting the pen and starting elsewhere leaves the space
      // between untouched, which is the whole point of drawing in pieces.
      const step = from < index ? 1 : -1;
      const startValue = Number.isFinite(next[from]!) ? next[from]! : value;
      const span = Math.abs(index - from);
      for (let k = 0; k <= span; k++) {
        next[from + k * step] = startValue + ((value - startValue) * k) / span;
      }
    }
    lastIndex.current = index;
    valuesRef.current = next;
    onChange(next);
  };

  return (
    <canvas
      ref={canvasRef}
      className="drawpad"
      style={{ height, opacity: disabled ? 0.45 : 1 }}
      onPointerDown={(e) => {
        if (disabled) return;
        drawing.current = true;
        lastIndex.current = null;
        e.currentTarget.setPointerCapture(e.pointerId);
        write(e);
      }}
      onPointerMove={(e) => {
        if (drawing.current) write(e);
      }}
      onPointerUp={(e) => {
        drawing.current = false;
        lastIndex.current = null;
        e.currentTarget.releasePointerCapture(e.pointerId);
      }}
      onPointerCancel={() => {
        drawing.current = false;
        lastIndex.current = null;
      }}
    />
  );
};

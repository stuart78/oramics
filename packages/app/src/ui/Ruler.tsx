/**
 * The time ruler above the lanes.
 *
 * Two jobs. It says where you are, which matters as soon as the whole sheet no
 * longer fits on screen, and it is the surface you drag to move along it. It
 * also shows the whole 30 s as a track with the visible slice marked, so a
 * zoomed-in view still tells you which part of the piece you are looking at.
 */

import { useCallback, useEffect, useRef, type JSX } from 'react';

import { readPadPalette } from './palette.js';
import { useViewWheel } from './useViewWheel.js';
import { gridStep, panBy, type View } from './view.js';

export interface RulerProps {
  view: View;
  onViewChange: (next: View) => void;
  duration: number;
  head?: number | null;
  theme?: string;
}

const HEIGHT = 26;

/** Seconds as 1.5 or 12, never 12.0, so labels stay narrow at every zoom. */
const label = (seconds: number, step: number): string =>
  step < 1 ? seconds.toFixed(step < 0.1 ? 2 : 1) : String(Math.round(seconds));

export const Ruler = ({
  view,
  onViewChange,
  duration,
  head = null,
  theme = 'dark',
}: RulerProps): JSX.Element => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const viewRef = useRef(view);
  viewRef.current = view;
  const dragging = useRef<{ x: number; from: number } | null>(null);

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

    const span = view.to - view.from;
    const px = (f: number): number => ((f - view.from) / span) * w;

    // The slice of the whole sheet on show, as a bar along the bottom.
    ctx.fillStyle = pal.grid;
    ctx.fillRect(0, h - 3, w, 3);
    ctx.fillStyle = pal.accent;
    ctx.fillRect(view.from * w, h - 3, Math.max(2, span * w), 3);

    const step = gridStep(duration * span);
    ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.textBaseline = 'top';

    const first = Math.ceil((view.from * duration) / step);
    const last = Math.floor((view.to * duration) / step);
    for (let k = first; k <= last; k++) {
      const seconds = k * step;
      const x = Math.round(px(seconds / duration)) + 0.5;
      const major = k % 5 === 0;
      ctx.strokeStyle = major ? pal.guide : pal.grid;
      ctx.beginPath();
      ctx.moveTo(x, major ? 4 : 9);
      ctx.lineTo(x, h - 5);
      ctx.stroke();
      if (major) {
        ctx.fillStyle = pal.muted;
        ctx.fillText(label(seconds, step), x + 3, 3);
      }
    }

    if (head !== null && head >= view.from && head <= view.to) {
      ctx.strokeStyle = pal.accent;
      ctx.lineWidth = 1.5;
      const x = Math.round(px(head)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
    }
  }, [duration, head, theme, view]);

  useEffect(() => {
    paint();
  }, [paint]);

  useEffect(() => {
    const onResize = (): void => paint();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [paint]);

  useViewWheel(canvasRef, viewRef, onViewChange);

  return (
    <canvas
      ref={canvasRef}
      className="ruler"
      style={{ height: HEIGHT }}
      onPointerDown={(e) => {
        dragging.current = { x: e.clientX, from: viewRef.current.from };
        e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        const drag = dragging.current;
        if (!drag) return;
        const rect = e.currentTarget.getBoundingClientRect();
        const span = viewRef.current.to - viewRef.current.from;
        // Drag right to move earlier, the way you would push the paper along.
        const moved = ((drag.x - e.clientX) / rect.width) * span;
        onViewChange(panBy({ from: drag.from, to: drag.from + span }, moved));
      }}
      onPointerUp={(e) => {
        dragging.current = null;
        e.currentTarget.releasePointerCapture(e.pointerId);
      }}
      onPointerCancel={() => {
        dragging.current = null;
      }}
    />
  );
};

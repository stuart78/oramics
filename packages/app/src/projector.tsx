/**
 * The projector view. Pure display — it holds no state, owns no audio, and
 * simply renders whatever the editor window broadcasts. That keeps a single
 * AudioContext in the app no matter how many windows are open.
 */

import { StrictMode, useEffect, useRef, useState, type JSX } from 'react';
import { createRoot } from 'react-dom/client';

import type { ProjectorMessage } from './App.js';
import { LANE_DEFS, type LaneTrack } from './lanes.js';
import { eachRun } from './ui/runs.js';
import './ui/styles.css';

interface Frame {
  lanes: Record<string, LaneTrack>;
  heads: Record<string, number>;
  hz: number;
  playing: boolean;
}

const Projector = (): JSX.Element => {
  const [frame, setFrame] = useState<Frame | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const channel = new BroadcastChannel('oramics');
    // Lanes and transport arrive separately; merge them into one view state.
    channel.onmessage = (e: MessageEvent<ProjectorMessage>) => {
      const msg = e.data;
      setFrame((prev) => {
        const base: Frame = prev ?? { lanes: {}, heads: {}, hz: 0, playing: false };
        return msg.kind === 'lanes'
          ? { ...base, lanes: msg.lanes }
          : { ...base, heads: msg.heads, hz: msg.hz, playing: msg.playing };
      });
    };
    return () => channel.close();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !frame) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    ctx.fillStyle = '#0a090c';
    ctx.fillRect(0, 0, w, h);

    const totalWeight = LANE_DEFS.reduce((s, d) => s + d.weight, 0);
    const gap = 10;
    const usable = h - gap * (LANE_DEFS.length - 1) - 40;
    let y = 20;

    for (const def of LANE_DEFS) {
      const bandH = (def.weight / totalWeight) * usable;
      const track = frame.lanes[def.name];

      ctx.fillStyle = '#141317';
      ctx.fillRect(0, y, w, bandH);

      ctx.strokeStyle = '#26242c';
      ctx.lineWidth = 1;
      for (let s = 1; s < 30; s++) {
        const x = Math.round((w * s) / 30) + 0.5;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x, y + bandH);
        ctx.stroke();
      }

      if (track) {
        // Same run splitting as the editor pad, so the two windows show the
        // same drawing. Feeding the whole array to one path put a line through
        // every blank stretch and joined marks that have nothing to do with
        // each other.
        const { values } = track;
        const n = values.length;
        ctx.strokeStyle = '#f2eee6';
        ctx.lineWidth = 3.5;
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        eachRun({ values, strokes: track.strokes }, (from, to) => {
          ctx.beginPath();
          for (let i = from; i <= to; i++) {
            const px = (i / (n - 1)) * w;
            const py = y + bandH * (1 - Math.max(0, Math.min(1, values[i]!)));
            if (i === from) ctx.moveTo(px, py);
            else ctx.lineTo(px, py);
          }
          if (from === to) ctx.lineTo((from / (n - 1)) * w + 0.01, y + bandH * (1 - values[from]!));
          ctx.stroke();
        });
      }

      ctx.fillStyle = '#6d6878';
      ctx.font = '600 13px ui-sans-serif, system-ui, sans-serif';
      ctx.fillText(def.label.toUpperCase(), 10, y + 16);

      const head = frame.heads[def.name];
      if (head !== undefined) {
        ctx.strokeStyle = '#ff7a4d';
        ctx.lineWidth = 2;
        const x = Math.round(head * w) + 0.5;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x, y + bandH);
        ctx.stroke();
      }

      y += bandH + gap;
    }

    ctx.fillStyle = '#9a94a8';
    ctx.font = '600 15px ui-monospace, monospace';
    ctx.fillText(frame.hz > 0 ? `${frame.hz.toFixed(0)} Hz` : '—', 10, h - 12);
  }, [frame]);

  return (
    <div className="projector">
      <canvas ref={canvasRef} />
      {!frame && <p className="waiting">Waiting for the editor window…</p>}
    </div>
  );
};

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Projector />
  </StrictMode>,
);

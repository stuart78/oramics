/**
 * The renderer's handle on the audio thread.
 *
 * Nothing here knows any DSP. It starts an AudioContext, loads the worklet, and
 * relays messages — the engine on the far side is the same module the tests
 * run against.
 */

import { SLIDE_HEIGHT, SLIDE_WIDTH, blurSpot, type LaneName } from '@oramics/engine';

import workletUrl from './worklet.ts?worker&url';

import { type EngineMessage, type MeterMessage } from './protocol.js';

export type MeterListener = (m: MeterMessage) => void;

export class AudioClient {
  private ctx: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private listeners = new Set<MeterListener>();
  /** Messages sent before the worklet existed, replayed once it does. */
  private pending: Array<{ msg: EngineMessage; transfer: Transferable[] }> = [];

  get sampleRate(): number {
    return this.ctx?.sampleRate ?? 0;
  }

  get running(): boolean {
    return this.ctx?.state === 'running';
  }

  /** Must be called from a user gesture — browsers will not start audio otherwise. */
  async start(): Promise<void> {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') await this.ctx.resume();
      return;
    }

    const ctx = new AudioContext({ latencyHint: 'interactive' });
    await ctx.audioWorklet.addModule(workletUrl);

    const node = new AudioWorkletNode(ctx, 'oramics', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
    });
    node.port.onmessage = (event: MessageEvent<MeterMessage>) => {
      if (event.data.type !== 'meters') return;
      for (const l of this.listeners) l(event.data);
    };
    node.connect(ctx.destination);

    this.ctx = ctx;
    this.node = node;

    for (const { msg, transfer } of this.pending) this.node.port.postMessage(msg, transfer);
    this.pending = [];
  }

  send(msg: EngineMessage, transfer: Transferable[] = []): void {
    if (!this.node) {
      this.pending.push({ msg, transfer });
      return;
    }
    this.node.port.postMessage(msg, transfer);
  }

  /** Copies first, so the caller keeps its own array and we transfer the copy. */
  sendLane(name: LaneName, data: Float32Array, durationS: number): void {
    const copy = new Float32Array(data);
    this.send({ type: 'lane', name, data: copy.buffer, durationS }, [copy.buffer]);
  }

  sendTimbre(index: number, contour: Float32Array): void {
    const copy = new Float32Array(contour);
    this.send({ type: 'timbre', index, contour: copy.buffer }, [copy.buffer]);
  }

  /**
   * Install a painted slide. The spot blur happens here rather than in the
   * worklet: it is a few million operations, which is fine on this thread and
   * a dropped buffer on the audio one.
   */
  sendSlide(index: number, field: Float32Array, width = SLIDE_WIDTH, height = SLIDE_HEIGHT): void {
    const blurred = blurSpot(field, width, height);
    const buffer = blurred.buffer as ArrayBuffer;
    this.send({ type: 'slide', index, field: buffer, width, height }, [buffer]);
  }

  setScanWindow(index: number, low: number, high: number): void {
    this.send({ type: 'scanWindow', index, low, high });
  }

  onMeters(listener: MeterListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async close(): Promise<void> {
    this.node?.disconnect();
    await this.ctx?.close();
    this.ctx = null;
    this.node = null;
  }
}

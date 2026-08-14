/**
 * Messages across the audio thread boundary.
 *
 * Lane and timbre payloads are sent as transferable ArrayBuffers, and only when
 * a sheet actually changes — which is a user action, not a per-frame event. That
 * is why there is no SharedArrayBuffer here, and therefore no COOP/COEP setup to
 * fight with: the traffic is rare and one-directional.
 */

import type { Fidelity, LaneName } from '@oramics/engine';

export type EngineMessage =
  | { type: 'lane'; name: LaneName; data: ArrayBuffer; durationS: number }
  | { type: 'clearLane'; name: LaneName }
  | { type: 'timbre'; index: number; contour: ArrayBuffer }
  /** A painted slide, already blurred for the spot — see Slide.preblurred. */
  | { type: 'slide'; index: number; field: ArrayBuffer; width: number; height: number }
  | { type: 'scanWindow'; index: number; low: number; high: number }
  | { type: 'fidelity'; patch: Partial<Fidelity> }
  | { type: 'globalSpeed'; value: number }
  | { type: 'laneSpeed'; name: LaneName; value: number }
  | { type: 'vibratoDepth'; cents: number }
  | { type: 'transport'; playing: boolean; rewind?: boolean };

export interface MeterMessage {
  type: 'meters';
  hz: number;
  gains: number[];
  /** Read-head position per lane, in seconds, in LANE_ORDER. */
  positions: number[];
}

/** The order `MeterMessage.positions` arrives in. */
export const LANE_ORDER: LaneName[] = [
  'pitch',
  'vibrato',
  'reverb',
  'transport',
  'amp1',
  'amp2',
  'amp3',
  'amp4',
];

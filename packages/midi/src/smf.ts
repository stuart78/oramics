/**
 * Reading a Standard MIDI File.
 *
 * Hand-rolled rather than pulled in, for the same reason the rest of this
 * project is: the format is small, the parts that matter here are notes, bends,
 * controllers and the tempo map, and owning it means the timing is ours to
 * reason about. It is also the only way to keep the package free of Node and the
 * DOM, so it runs in the app and in a test without two versions of anything.
 *
 * What is handled: format 0 and 1, running status, tempo changes anywhere in
 * any track, and both timebases. Format 2 is a set of independent sequences
 * rather than one piece, and is refused rather than silently played as one.
 */

export interface NoteEvent {
  /** Seconds from the start of the file. */
  at: number;
  seconds: number;
  /** MIDI note number, 0-127. */
  note: number;
  /** 0-1. */
  velocity: number;
  channel: number;
  /** Index of the track it came from, for spreading parts across timbres. */
  track: number;
}

export interface ControlEvent {
  at: number;
  /** Controller number, or -1 for pitch bend. */
  controller: number;
  /** 0-1 for controllers, -1 to 1 for bend. */
  value: number;
  channel: number;
  track: number;
}

export interface Song {
  notes: NoteEvent[];
  controls: ControlEvent[];
  /** Seconds to the end of the last sounding note. */
  duration: number;
  /** How many tracks carried notes. */
  parts: number;
  name: string | null;
}

export class MidiError extends Error {}

/** Cursor over the bytes, so the parsers below stay readable. */
class Reader {
  private at = 0;

  constructor(private readonly bytes: Uint8Array) {}

  get done(): boolean {
    return this.at >= this.bytes.length;
  }

  get offset(): number {
    return this.at;
  }

  byte(): number {
    if (this.at >= this.bytes.length) throw new MidiError('file ends mid-event');
    return this.bytes[this.at++]!;
  }

  peek(): number {
    if (this.at >= this.bytes.length) throw new MidiError('file ends mid-event');
    return this.bytes[this.at]!;
  }

  uint16(): number {
    return (this.byte() << 8) | this.byte();
  }

  uint32(): number {
    return ((this.byte() << 24) | (this.byte() << 16) | (this.byte() << 8) | this.byte()) >>> 0;
  }

  text(length: number): string {
    let out = '';
    for (let i = 0; i < length; i++) out += String.fromCharCode(this.byte());
    return out;
  }

  skip(length: number): void {
    this.at += length;
  }

  /** Step back one byte, for running status: the byte read was data, not status. */
  back(): void {
    this.at--;
  }

  slice(length: number): Uint8Array {
    const out = this.bytes.subarray(this.at, this.at + length);
    this.at += length;
    return out;
  }

  /** Variable-length quantity: seven bits a byte, high bit means "more". */
  varint(): number {
    let value = 0;
    for (let i = 0; i < 4; i++) {
      const b = this.byte();
      value = (value << 7) | (b & 0x7f);
      if ((b & 0x80) === 0) return value;
    }
    throw new MidiError('a variable-length quantity ran past four bytes');
  }
}

/** One event with its absolute position in ticks, before the tempo map is applied. */
interface Timed {
  tick: number;
  track: number;
  status: number;
  a: number;
  b: number;
  /** Microseconds per quarter note, for a tempo meta event. */
  tempo?: number;
  name?: string;
}

const readTrack = (reader: Reader, track: number, into: Timed[]): void => {
  if (reader.text(4) !== 'MTrk') throw new MidiError('expected a track chunk');
  const length = reader.uint32();
  const end = reader.offset + length;

  let tick = 0;
  let status = 0;

  while (reader.offset < end) {
    tick += reader.varint();
    let byte = reader.byte();

    // Running status: a data byte where a status byte was expected means the
    // previous status still applies. Common enough that ignoring it corrupts
    // most files written by a sequencer.
    if (byte < 0x80) {
      if (status === 0) throw new MidiError('running status with nothing to run');
      reader.back();
      byte = status;
    } else if (byte < 0xf0) {
      status = byte;
    }

    if (byte === 0xff) {
      const type = reader.byte();
      const len = reader.varint();
      if (type === 0x51 && len === 3) {
        const tempo = (reader.byte() << 16) | (reader.byte() << 8) | reader.byte();
        into.push({ tick, track, status: 0, a: 0, b: 0, tempo });
      } else if (type === 0x03) {
        into.push({ tick, track, status: 0, a: 0, b: 0, name: reader.text(len) });
      } else {
        reader.skip(len);
      }
      continue;
    }

    if (byte === 0xf0 || byte === 0xf7) {
      reader.skip(reader.varint());
      continue;
    }

    const kind = byte & 0xf0;
    const a = reader.byte();
    // Program change and channel pressure carry one data byte; everything else
    // carries two.
    const b = kind === 0xc0 || kind === 0xd0 ? 0 : reader.byte();
    into.push({ tick, track, status: byte, a, b });
  }

  // Trust the chunk length over our own arithmetic: a track with an event this
  // parser skipped badly should not eat the next track.
  while (reader.offset < end) reader.byte();
};

/**
 * Convert ticks to seconds through the tempo map.
 *
 * Tempo changes are absolute points, so the elapsed time up to a tick is the sum
 * of the spans before it. Files that change tempo mid-piece are common, and
 * assuming 120 bpm throughout puts everything after the first change in the
 * wrong place.
 */
const makeClock = (
  events: Timed[],
  division: number,
): ((tick: number) => number) => {
  const smpte = (division & 0x8000) !== 0;
  if (smpte) {
    // Negative frames per second in the high byte, ticks per frame in the low.
    const framesPerSecond = 256 - (division >> 8);
    const ticksPerFrame = division & 0xff;
    const perTick = 1 / (framesPerSecond * ticksPerFrame);
    return (tick) => tick * perTick;
  }

  const ticksPerQuarter = division === 0 ? 480 : division;
  const changes = events
    .filter((e) => e.tempo !== undefined)
    .sort((a, b) => a.tick - b.tick);

  // Anchor each tempo change with the seconds elapsed when it takes effect.
  const anchors: { tick: number; seconds: number; perTick: number }[] = [];
  let seconds = 0;
  let perTick = 500_000 / 1e6 / ticksPerQuarter; // 120 bpm until told otherwise
  let previous = 0;
  for (const change of changes) {
    seconds += (change.tick - previous) * perTick;
    previous = change.tick;
    perTick = change.tempo! / 1e6 / ticksPerQuarter;
    anchors.push({ tick: change.tick, seconds, perTick });
  }
  if (anchors.length === 0 || anchors[0]!.tick > 0) {
    anchors.unshift({ tick: 0, seconds: 0, perTick: 500_000 / 1e6 / ticksPerQuarter });
  }

  return (tick) => {
    let i = 0;
    while (i + 1 < anchors.length && anchors[i + 1]!.tick <= tick) i++;
    const anchor = anchors[i]!;
    return anchor.seconds + (tick - anchor.tick) * anchor.perTick;
  };
};

export const parseMidi = (bytes: Uint8Array): Song => {
  const reader = new Reader(bytes);
  if (reader.text(4) !== 'MThd') throw new MidiError('not a MIDI file');

  const headerLength = reader.uint32();
  const format = reader.uint16();
  const trackCount = reader.uint16();
  const division = reader.uint16();
  reader.skip(headerLength - 6);

  if (format === 2) {
    throw new MidiError('format 2 files hold separate sequences, not one piece');
  }

  const timed: Timed[] = [];
  for (let t = 0; t < trackCount && !reader.done; t++) readTrack(reader, t, timed);

  const clock = makeClock(timed, division);
  timed.sort((a, b) => a.tick - b.tick);

  const notes: NoteEvent[] = [];
  const controls: ControlEvent[] = [];
  const parts = new Set<number>();
  let name: string | null = null;

  /** Notes waiting for their note-off, keyed by track, channel and number. */
  const sounding = new Map<string, { at: number; velocity: number; index: number }>();
  const key = (e: Timed, note: number): string => `${e.track}:${e.status & 0x0f}:${note}`;

  for (const event of timed) {
    if (event.name !== undefined) {
      name ??= event.name.trim() || null;
      continue;
    }
    if (event.status === 0) continue;

    const kind = event.status & 0xf0;
    const channel = event.status & 0x0f;
    const at = clock(event.tick);

    if (kind === 0x90 && event.b > 0) {
      // Retrigger without a note-off: end the old one where the new one starts.
      const open = sounding.get(key(event, event.a));
      if (open) notes[open.index]!.seconds = Math.max(0, at - open.at);
      const index = notes.length;
      notes.push({ at, seconds: 0, note: event.a, velocity: event.b / 127, channel, track: event.track });
      sounding.set(key(event, event.a), { at, velocity: event.b / 127, index });
      parts.add(event.track);
      continue;
    }

    // A note-on at zero velocity is a note-off, and most files use it.
    if (kind === 0x80 || (kind === 0x90 && event.b === 0)) {
      const open = sounding.get(key(event, event.a));
      if (open) {
        notes[open.index]!.seconds = Math.max(0, at - open.at);
        sounding.delete(key(event, event.a));
      }
      continue;
    }

    if (kind === 0xb0) {
      controls.push({ at, controller: event.a, value: event.b / 127, channel, track: event.track });
      continue;
    }

    if (kind === 0xe0) {
      const raw = (event.b << 7) | event.a; // 14 bits, 8192 is centre
      controls.push({ at, controller: -1, value: (raw - 8192) / 8192, channel, track: event.track });
    }
  }

  // Anything still held at the end of the file sounds until then.
  let duration = 0;
  for (const note of notes) duration = Math.max(duration, note.at + note.seconds);
  for (const [, open] of sounding) {
    notes[open.index]!.seconds = Math.max(0, duration - open.at);
  }

  return { notes, controls, duration, parts: parts.size, name };
};

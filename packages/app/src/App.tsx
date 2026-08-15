import { useCallback, useEffect, useLayoutEffect, useRef, useState, type JSX } from 'react';

import { randomSlideField, type Fidelity } from '@oramics/engine';

import { AudioClient } from './audio/client.js';
import { LANE_ORDER } from './audio/protocol.js';
import { exportSessionPdf } from './export.js';
import type { SessionSettings } from './session.js';
import { openSession, saveSession } from './sessionFile.js';
import type { ShellCommand } from './shell.js';
import {
  LANE_DEFS,
  SLIDE_HEIGHT,
  SLIDE_WIDTH,
  makeAllLanes,
  type LaneMap,
  type LaneTrack,
} from './lanes.js';
import { DrawPad } from './ui/DrawPad.js';
import { PaintPad } from './ui/PaintPad.js';
import { Ruler } from './ui/Ruler.js';
import { applyTheme, initialTheme, type Theme } from './ui/theme.js';
import { FULL, follow, zoomAt, type View } from './ui/view.js';

/** Matches the printed sheet: 300 mm of field at 10 mm/s. */
const DURATION_S = 30;

/**
 * How often a slide being painted is pushed to the audio thread.
 *
 * Each push blurs a 512x256 field for the scanning spot — about 8 ms — and
 * transfers half a megabyte. Doing that per pointer move saturates the main
 * thread and floods the worklet's port. Coalescing to roughly ten a second is
 * imperceptible while painting and leaves both threads idle in between; the
 * pending map always holds the latest field, so the final state of a stroke
 * still lands.
 */
const SLIDE_PUSH_MS = 90;

/**
 * Broadcast to the projector window; it holds no state of its own.
 *
 * Split in two because the head positions arrive about thirty times a second
 * and the lane drawings are tens of kilobytes. Sending both together meant
 * structured-cloning every lane on every meter tick.
 */
export type ProjectorMessage =
  | { kind: 'lanes'; lanes: Record<string, LaneTrack> }
  | { kind: 'transport'; heads: Record<string, number>; hz: number; playing: boolean };

export const App = (): JSX.Element => {
  const [lanes, setLanes] = useState<LaneMap>(makeAllLanes);
  // Start on randomised slides rather than four identical sines: a fresh
  // session should already sound like something.
  const [slides, setSlides] = useState<Float32Array[]>(() =>
    Array.from(
      { length: 4 },
      () =>
        randomSlideField(Math.floor(Math.random() * 2 ** 31), {
          roundness: 0.5,
          wildness: 0.4,
        }).field,
    ),
  );

  const [theme, setTheme] = useState<Theme>(initialTheme);

  // A layout effect, not a passive one: passive effects run children-first, so
  // the pads would repaint from the old palette before this landed.
  useLayoutEffect(() => {
    applyTheme(theme);
  }, [theme]);
  const [erasing, setErasing] = useState(false);
  /** Bias for the generator: 0 spiky and harsh, 1 round and soft. */
  const [character, setCharacter] = useState(0.5);
  /** How eventful generated slides are — gaps, stacked ribbons, weight changes. */
  const [wildness, setWildness] = useState(0.4);
  const [playing, setPlaying] = useState(false);
  const [globalSpeed, setGlobalSpeed] = useState(1);
  const [vibratoCents, setVibratoCents] = useState(50);
  const [fidelity, setFidelity] = useState<Fidelity>({
    integerHzPitch: true,
    linearPitchScale: true,
    relayLag: true,
    opticalAmplitude: true,
    monoSum: true,
    servoScanner: true,
    transportLane: true,
  });
  const [heads, setHeads] = useState<Record<string, number>>({});
  const [hz, setHz] = useState(0);
  const [status, setStatus] = useState('');
  /** The slice of the sheet on screen. One window, every lane. */
  const [view, setView] = useState<View>(FULL);

  const client = useRef<AudioClient>(null);
  if (client.current === null) client.current = new AudioClient();

  const channel = useRef<BroadcastChannel>(null);
  if (channel.current === null) channel.current = new BroadcastChannel('oramics');

  // Push every lane once the worklet exists; the client queues until then.
  useEffect(() => {
    for (const def of LANE_DEFS) {
      client.current!.sendLane(def.name, lanes[def.name].values, DURATION_S);
    }
    slides.forEach((f, i) => client.current!.sendSlide(i, f));
    // Deliberately once on mount — later edits push individually.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const off = client.current!.onMeters((m) => {
      const next: Record<string, number> = {};
      LANE_ORDER.forEach((name, i) => {
        next[name] = (m.positions[i] ?? 0) / DURATION_S;
      });
      setHeads(next);
      setHz(m.hz);
    });
    return off;
  }, []);

  // The projector is a pure view. Drawings go only when they change...
  useEffect(() => {
    channel.current!.postMessage({ kind: 'lanes', lanes } satisfies ProjectorMessage);
  }, [lanes]);

  // ...and the read heads go at meter rate, carrying nothing bulky.
  useEffect(() => {
    channel.current!.postMessage({ kind: 'transport', heads, hz, playing } satisfies ProjectorMessage);
  }, [heads, hz, playing]);

  /*
   * Keep the pitch head in shot while playing.
   *
   * Zoomed in, a moving head leaves the window within a second or two and you
   * end up chasing it by hand. `follow` pages rather than creeps, and returns
   * the view unchanged while the head is comfortably inside, so this settles
   * instead of re-rendering on every meter tick.
   */
  useEffect(() => {
    if (!playing) return;
    const at = heads.pitch;
    if (at === undefined) return;
    setView((prev) => follow(prev, at));
  }, [heads, playing]);

  const updateLane = useCallback((name: keyof LaneMap, track: LaneTrack) => {
    setLanes((prev) => ({ ...prev, [name]: track }));
    client.current!.sendLane(name, track.values, DURATION_S);
  }, []);

  const pendingSlides = useRef(new Map<number, Float32Array>());
  const slideTimer = useRef<number | null>(null);

  const flushSlides = useCallback(() => {
    slideTimer.current = null;
    for (const [index, painted] of pendingSlides.current) {
      client.current!.sendSlide(index, painted);
    }
    pendingSlides.current.clear();
  }, []);

  useEffect(() => () => {
    if (slideTimer.current !== null) window.clearTimeout(slideTimer.current);
  }, []);

  const updateSlide = useCallback(
    (index: number, painted: Float32Array) => {
      // The canvas updates immediately; only the push to audio is coalesced.
      setSlides((prev) => prev.map((f, i) => (i === index ? painted : f)));
      pendingSlides.current.set(index, painted);
      if (slideTimer.current === null) {
        slideTimer.current = window.setTimeout(flushSlides, SLIDE_PUSH_MS);
      }
    },
    [flushSlides],
  );

  const randomiseSlide = useCallback(
    (index: number) => {
      // Jitter around the slider so repeated presses at one setting still vary.
      const roundness = Math.max(0, Math.min(1, character + (Math.random() - 0.5) * 0.2));
      const seed = Math.floor(Math.random() * 2 ** 31);
      const { field } = randomSlideField(seed, { roundness, wildness });
      updateSlide(index, field);
    },
    [character, wildness, updateSlide],
  );

  const randomiseAll = useCallback(() => {
    for (let i = 0; i < 4; i++) randomiseSlide(i);
  }, [randomiseSlide]);

  const togglePlay = async (): Promise<void> => {
    // Browsers only allow an AudioContext to start from a user gesture.
    await client.current!.start();
    const next = !playing;
    setPlaying(next);
    client.current!.send({ type: 'transport', playing: next });
  };

  const rewind = (): void => {
    client.current!.send({ type: 'transport', playing, rewind: true });
  };

  const patchFidelity = (patch: Partial<Fidelity>): void => {
    setFidelity((prev) => ({ ...prev, ...patch }));
    client.current!.send({ type: 'fidelity', patch });
  };

  const onExport = async (): Promise<void> => {
    setStatus('building PDF…');
    try {
      const path = await exportSessionPdf({ lanes, slides });
      setStatus(path ? `saved ${path}` : 'export cancelled');
    } catch (err) {
      setStatus(`export failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const settings = (): SessionSettings => ({ globalSpeed, vibratoCents, fidelity });

  const onSave = async (): Promise<void> => {
    try {
      const path = await saveSession({ lanes, slides, settings: settings() });
      setStatus(path ? `saved ${path}` : 'save cancelled');
    } catch (err) {
      setStatus(`save failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const onOpen = async (): Promise<void> => {
    try {
      const opened = await openSession(settings());
      if (!opened) return setStatus('open cancelled');

      const { session, path } = opened;
      setLanes(session.lanes);
      setSlides(session.slides);
      setGlobalSpeed(session.settings.globalSpeed);
      setVibratoCents(session.settings.vibratoCents);
      setFidelity(session.settings.fidelity);
      setView(FULL);

      // Push the lot to the engine. Nothing else does: the individual editors
      // send their own changes, and none of them fired here.
      const client_ = client.current!;
      for (const def of LANE_DEFS) client_.sendLane(def.name, session.lanes[def.name].values, DURATION_S);
      session.slides.forEach((field, i) => client_.sendSlide(i, field));
      client_.send({ type: 'globalSpeed', value: session.settings.globalSpeed });
      client_.send({ type: 'vibratoDepth', cents: session.settings.vibratoCents });
      client_.send({ type: 'fidelity', patch: session.settings.fidelity });

      setStatus(`opened ${path}`);
    } catch (err) {
      setStatus(`open failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  /*
   * Menu commands.
   *
   * Held in a ref rather than resubscribed, because the handlers close over the
   * lanes and slides and would otherwise tear down and rebuild the listener on
   * every stroke. The ref is rewritten each render, so a command always reaches
   * the current one.
   */
  const commands = useRef<Record<ShellCommand, () => void>>(null!);
  commands.current = {
    open: () => void onOpen(),
    save: () => void onSave(),
    'export-pdf': () => void onExport(),
    'zoom-in': () => setView((v) => zoomAt(v, 0.5, 0.5)),
    'zoom-out': () => setView((v) => zoomAt(v, 0.5, 2)),
    'zoom-fit': () => setView(FULL),
    theme: () => setTheme((t) => (t === 'dark' ? 'light' : 'dark')),
  };

  useEffect(() => window.oramics?.onCommand((command) => commands.current[command]?.()), []);

  return (
    <div className="app">
      <header className="bar">
        <div className="brand">
          <strong>DAPHNE</strong>
          <span className="muted">30.000 s · 1 cm = 1 s</span>
        </div>

        <div className="controls">
          <button className={playing ? 'primary on' : 'primary'} onClick={togglePlay}>
            {playing ? 'Stop' : 'Play'}
          </button>
          <button onClick={rewind}>Rewind</button>

          <label>
            Speed
            <input
              type="range"
              min={0.1}
              max={3}
              step={0.01}
              value={globalSpeed}
              onChange={(e) => {
                const v = Number(e.target.value);
                setGlobalSpeed(v);
                client.current!.send({ type: 'globalSpeed', value: v });
              }}
            />
            <span className="value">{globalSpeed.toFixed(2)}x</span>
          </label>

          <label>
            Vibrato
            <input
              type="range"
              min={0}
              max={400}
              step={1}
              value={vibratoCents}
              onChange={(e) => {
                const v = Number(e.target.value);
                setVibratoCents(v);
                client.current!.send({ type: 'vibratoDepth', cents: v });
              }}
            />
            <span className="value">{vibratoCents}¢</span>
          </label>

          <span className="readout">{hz > 0 ? `${hz.toFixed(hz < 100 ? 1 : 0)} Hz` : '—'}</span>
        </div>

        <div className="controls">
          <label className="toggle">
            <input
              type="checkbox"
              checked={erasing}
              onChange={(e) => setErasing(e.target.checked)}
            />
            Erase
          </label>
          <button
            onClick={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
            title="Switch between light and dark"
          >
            {theme === 'dark' ? 'Light' : 'Dark'}
          </button>
          <button onClick={onOpen}>Open</button>
          <button onClick={onSave}>Save</button>
          <button onClick={onExport}>Export PDF</button>
          <button onClick={() => window.oramics?.toggleProjector()}>Projector</button>
        </div>
      </header>

      <section className="fidelity">
        <span className="muted">Fidelity</span>
        {(
          [
            ['servoScanner', 'Flying-spot scanner'],
            ['linearPitchScale', 'Pitch in Hertz'],
            ['relayLag', 'Relay lag'],
            ['transportLane', 'Transport strip'],
            ['integerHzPitch', 'Whole-Hertz pitch'],
            ['opticalAmplitude', 'Optical amplitude'],
            ['monoSum', 'Mono'],
          ] as const
        ).map(([key, label]) => (
          <label key={key} className="toggle">
            <input
              type="checkbox"
              checked={fidelity[key]}
              onChange={(e) => patchFidelity({ [key]: e.target.checked })}
            />
            {label}
          </label>
        ))}
        <span className="muted small">Turn these off to leave 1969 behind.</span>
        {status && <span className="status">{status}</span>}
      </section>

      <main className="lanes">
        <div className="timeline">
          <Ruler
            view={view}
            onViewChange={setView}
            duration={DURATION_S}
            head={heads.pitch ?? null}
            theme={theme}
          />
          <span className="zoom" title="Pinch, or hold ⌘ and scroll over a lane. Shift-scroll to move along, or drag the ruler.">
            <button
              onClick={() => setView((v) => zoomAt(v, 0.5, 2))}
              disabled={view.to - view.from >= 1}
            >
              −
            </button>
            <span className="value">{((view.to - view.from) * DURATION_S).toFixed(1)} s</span>
            <button onClick={() => setView((v) => zoomAt(v, 0.5, 0.5))}>+</button>
            <button onClick={() => setView(FULL)} disabled={view.to - view.from >= 1}>
              Fit
            </button>
          </span>
        </div>
        {LANE_DEFS.map((def) => (
          <div className="lane" key={def.name}>
            <div className="lane-label">
              <strong>{def.label}</strong>
              <span className="muted small">{def.hint}</span>
              {def.pending && <span className="pending">not yet wired</span>}
            </div>
            <DrawPad
              track={lanes[def.name]}
              onChange={(t) => updateLane(def.name, t)}
              head={heads[def.name] ?? null}
              bipolar={def.bipolar}
              fill={!def.bipolar && def.name !== 'pitch'}
              guides={def.name === 'pitch' ? [0.11, 0.22, 0.44, 0.88] : [0.5]}
              erasing={erasing}
              theme={theme}
              view={view}
              onViewChange={setView}
              duration={DURATION_S}
              height={Math.round(def.weight * 46)}
            />
          </div>
        ))}
      </main>

      <section className="timbres">
        <div className="timbres-head">
          <span className="muted">
            Slides — the spot rides the <em>top edge</em>; a gap drops the spot, and a second
            ribbon gives the loop something to jump to.
          </span>
          <div className="slide-tools">
            <label title="Spectral tilt of the generated stroke">
              Round
              <input
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={character}
                onChange={(e) => setCharacter(Number(e.target.value))}
              />
              Spiky
            </label>
            <label title="How often gaps and stacked ribbons appear">
              Calm
              <input
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={wildness}
                onChange={(e) => setWildness(Number(e.target.value))}
              />
              Wild
            </label>
            <button onClick={randomiseAll}>Randomise all</button>
          </div>
        </div>
        <div className="timbres-grid">
          {slides.map((field, i) => (
            <div className="timbre" key={i}>
              <div className="lane-label">
                <strong>Timbre {i + 1}</strong>
                <span className="muted small">one cycle</span>
                <button
                  className="dice"
                  title={`Randomise timbre ${i + 1}`}
                  onClick={() => randomiseSlide(i)}
                >
                  Randomise
                </button>
              </div>
              <PaintPad
                field={field}
                width={SLIDE_WIDTH}
                height={SLIDE_HEIGHT}
                onChange={(f) => updateSlide(i, f)}
                erasing={erasing}
                theme={theme}
                displayHeight={124}
              />
            </div>
          ))}
        </div>
      </section>
    </div>
  );
};


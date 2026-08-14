# Oramics

A drawn-sound instrument after Daphne Oram's Oramics machine — faithfully, and
then unfaithfully.

```bash
pnpm install
pnpm dev          # Electron app
pnpm template     # print sheets for contributors
pnpm test
pnpm dist         # package a macOS app
```

## Cutting a build

```bash
pnpm dist               # arm64 .dmg + .zip, into packages/shell/release
pnpm --filter @oramics/shell run build:universal   # Intel + Apple Silicon
pnpm --filter @oramics/shell run build:dir         # unpacked .app, no installer
```

`stage.mjs` copies the Vite build into `packages/shell/renderer` first, so the
packaged app is self-contained: the whole bundle is `main.cjs`, `preload.cjs`
and the renderer, with **no `node_modules` at all**. Vite has already bundled
everything the renderer uses, and the shell has no runtime dependencies — which
neatly avoids the usual pnpm/electron-builder hoisting problems.

The build is **not code-signed** (`identity: null`). It runs fine on the machine
that built it; on any other Mac, Gatekeeper will quarantine it and the user has
to right-click → Open once, or:

```bash
xattr -dr com.apple.quarantine /Applications/Oramics.app
```

Signing and notarising needs an Apple Developer account. Worth doing before the
workshop if the app is going onto a machine that is not yours.

The icon is generated, not checked in — `pnpm icon` writes
`packages/shell/build-resources/icon.png`, which electron-builder converts to
`.icns`.

## Packages

| | |
|---|---|
| `engine` | The voice. Pure TypeScript — no Web Audio, no DOM, no Node. |
| `template` | Printable drawing sheets, and the geometry everything shares. |
| `app` | Renderer: drawing surfaces, audio client, projector view, PDF export. |
| `shell` | Electron: windows, external display, save dialog. |

The engine's purity is the load-bearing decision. The same module runs in the
AudioWorklet, in an offline bounce at whatever speed the CPU allows, and in a
unit test — and it lifts into WASM or a JUCE plugin later without a rewrite. A
test asserts that a 128-sample worklet render and an offline bounce agree to
1e-9, so a bounce is guaranteed to match what was heard.

## The machine, and where we depart from it

Ten synchronised 35 mm film strips ran over photocells: three carried pitch as
binary-coded whole Hertz, four carried amplitude (one per timbre), and one each
carried vibrato, reverberation and transport. Four hand-painted glass slides in
front of CRTs supplied the waveforms — a photomultiplier feedback loop dragged a
scanning dot onto the painted contour, and the Y voltage was the wave. Output
was mono; polyphony came from multitracking to tape.

Three of its constraints are modelled rather than approximated, because they are
most of why it sounds like it does:

- **The flying-spot scanner.** Not a wavetable — a servo. See below.
- **Whole-Hertz pitch.** 100 → 101 Hz is 17 cents down low and 2 cents up high.
  Uneven resolution across the range is the point.
- **Optical amplitude.** Level was set by shining a torch bulb at a
  photoresistor. Filament thermal mass plus asymmetric cell recovery means no
  envelope has a sharp attack and released notes hang on.

Each is a runtime toggle, not a build flag — the second half of a workshop is
turning them off one at a time.

### Why the timbres are a servo, not a wavetable

Oram's surviving slides carry four thick, irregular ribbons of paint stacked
vertically, each spanning the full width, with clear glass above *and* below.
None of that is a single-valued function of x.

Wrench describes how the machine read them: the spot sweeps left to right, and
"if obscured by the opaque part of the drawn waveform, the photomultiplier would
detect no light, and the beam would move higher until the photomultiplier could
see it." Dark pushes the spot up, light pulls it down, and it balances on the
**top edge** of the paint. So `scanner.ts` runs that loop at audio rate over a
2-D opacity field — one bilinear lookup and a handful of flops per sample — and
the character falls out rather than being bolted on:

- **Timbre changes with pitch.** The sweep rate is the note frequency; the loop
  bandwidth is fixed. Measured on one slide: a normalised shape factor of 2.58
  at 73 Hz and 0.52 at 766 Hz — smoother than a sine, the loop having rounded
  the whole stroke off. The wavetable path reads 2.55 and 2.57, pitch-invariant
  by construction. This is the difference a table cannot fake.
- **Ribbon thickness is inaudible.** The underside is unreachable.
- **A gap costs level, not just a click.** The spot dives to the rail and the
  AC coupling strips the DC, so a gapped stroke came out 5× quieter than the
  same stroke intact.
- **Complex shapes get harsher, exactly as the museum caption says.** One smooth
  ribbon reads 1.38; add a fast wiggle band above it and it reads 7.73.
- **It rings, and inharmonically** — the loop's natural frequency is absolute,
  so the ring does not transpose with the note.
- **Cycles are not identical.** Loop state carries across the flyback.

Free-floating ribbons are only *locally* stable — a spot below one sees light
and dies on the bottom rail — so the loop has a search mode, as real tracking
servos do. It sweeps up to reacquire, but only when the column actually contains
paint: an empty carrier sits dark instead of hunting.

## The 30-second guarantee

The printed time field is exactly 300 mm at 10 mm/s, so a sheet is 30.000 s by
construction, 1 cm is 1 second, and 1 mm is 100 ms. That is one tenth of the
machine's 100 mm/s film speed; at hers, a Legal sheet would last 3.5 seconds.

Nothing downstream measures millimetres off paper. Four corner fiducials define
a reference rectangle, the extractor solves a homography onto their known
coordinates, and print scale, scan DPI, skew and lens distortion all fall out.
Each sheet also carries a QR describing itself, so importing is scan-and-drop
and the app takes its transport speed from the sheet.

See [`packages/template/README.md`](packages/template/README.md).

## Round trip

Draw in the app, **Export PDF**, and you get the same two sheets contributors
draw on with your lines printed onto them. Print it, let someone mark it up by
hand, scan it back. That only works because the app and the printed template
share one geometry module.

## Status

Working: the voice, the printable sheets, in-app drawing, live audio, the
projector window, PDF export.

Not yet: importing scanned sheets (the `vision` package — registration,
extraction, the photocell model), reverberation, and the transport lane feeding
back into its own speed. The reverb and transport lanes are drawable and marked
"not yet wired" in the UI rather than silently doing nothing.

## Licence and attribution

GPL-3.0. See [LICENSE](LICENSE).

This is an independent reconstruction, not affiliated with the Daphne Oram
Trust, Goldsmiths, or the Science Museum. It is built from published accounts of
the machine — chiefly Graham Wrench's, who designed and built the original
electronics — and every departure from what those accounts describe is marked in
the code and switchable in the app.

## Known environment quirk

On macOS, electron's postinstall sometimes produces a ~250 KB `dist` instead of
the real ~250 MB one — `extract-zip` does not handle the symlinks inside
`Electron.app` and gives up silently, with a zero exit code. You get:

```
Error: Electron failed to install correctly, please delete node_modules/electron
```

The download is fine and already cached; only the extract failed. Repair it:

```bash
pnpm fix:electron
```

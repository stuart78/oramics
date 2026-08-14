# Oramics

A drawn-sound instrument after Daphne Oram's Oramics machine. You draw the
sound, on paper or on screen, and the machine plays what you drew.

Built for running workshops. Print the sheets, let people draw on them, play the
results.

**[Download v0.0.1](https://github.com/stuart78/oramics/releases/tag/v0.0.1)**
for macOS, Windows or Linux. The builds are unsigned, so see the release notes
for the one-time step your OS will ask for.

```bash
pnpm install
pnpm dev          # run the app
pnpm template     # generate sheets to print
pnpm test
```

## Packages

| | |
|---|---|
| `engine` | The voice. Plain TypeScript, no Web Audio, no DOM, no Node. |
| `template` | Printable sheets, and the geometry everything shares. |
| `app` | Drawing surfaces, audio client, projector view, PDF export. |
| `shell` | Electron: windows, external display, save dialog. |

Keeping the engine free of platform code is the decision everything else rests
on. The same module runs in the AudioWorklet, in an offline bounce at whatever
speed the CPU manages, and in a unit test. It can move to WASM or a JUCE plugin
later without a rewrite. A test asserts that a 128-sample worklet render and an
offline bounce agree to 1e-9, so a bounce always matches what you heard.

## The machine

Ten synchronised 35 mm film strips ran over photocells. Four carried pitch as
binary-coded whole Hertz, four carried amplitude (one per timbre), and one each
carried vibrato, reverberation and transport. Four hand-painted glass slides sat
in front of CRTs to supply the waveforms: a photomultiplier feedback loop
dragged a scanning dot onto the painted contour, and the resulting voltage was
the wave. Output was mono. Polyphony came from multitracking to tape.

Several of its constraints are modelled rather than approximated, because they
are most of why it sounds the way it does. Each is a switch in the app, so you
can hear 1969 and then leave it.

### Timbre is a servo, not a wavetable

Oram's surviving slides carry four thick, irregular ribbons of paint stacked
vertically, each spanning the full width, with clear glass above and below.
None of that is a single-valued function of x.

Graham Wrench, who built the electronics, described how the machine read them:
the spot sweeps left to right, and "if obscured by the opaque part of the drawn
waveform, the photomultiplier would detect no light, and the beam would move
higher until the photomultiplier could see it." Dark pushes the spot up, light
pulls it down, and it balances on the *top edge* of the paint.

So `scanner.ts` runs that loop at audio rate over a 2-D opacity field, one
bilinear lookup and a few flops per sample. The character comes out of the loop
rather than being added afterwards:

- **Timbre changes with pitch.** The sweep rate is the note frequency, but the
  loop bandwidth is fixed. Measured on one slide, a normalised shape factor of
  2.58 at 73 Hz and 0.52 at 766 Hz, smoother than a sine because the loop has
  rounded the whole stroke off. The wavetable path reads 2.55 and 2.57, flat by
  construction. A table cannot do this.
- **Ribbon thickness is inaudible.** The underside is unreachable.
- **A gap costs level, not just a click.** The spot dives to the rail and the AC
  coupling strips the DC, so a gapped stroke came out 5x quieter than the same
  stroke intact.
- **Complex shapes get harsher**, matching the Science Museum caption. One
  smooth ribbon reads 1.38. Add a fast wiggle band above it and it reads 7.73.
- **It rings, inharmonically.** The loop's natural frequency is fixed, so the
  ring does not transpose with the note.
- **No two cycles are identical.** Loop state carries across the flyback.

Free-floating ribbons are only locally stable. A spot below one sees light and
dies on the bottom rail, so the loop has a search mode, as real tracking servos
do. It sweeps up to reacquire, but only when the column actually contains paint.
An empty carrier sits dark instead of hunting.

### Pitch is a whole number of Hertz

Wrench again: "one strip would set the number of units of cycles per second; one
set the number of tens of cycles; a third set the number of hundreds of cycles;
the last would set the number of thousands." Those relays "switch in banks of
resistors and make the time-base run at whatever frequency."

Resistors in parallel, so conductance sums, so frequency is proportional to the
coded number. The painted code does not represent a pitch. It *is* the frequency
in Hertz. Two things follow:

- **The scale is linear, not logarithmic.** Octaves fall unevenly: 110 Hz a
  ninth of the way up, 220 at a fifth, 440 just under half, 880 near the top.
  Drawing a tune on it feels wrong, and that is the authentic feeling.
- **Resolution is one Hertz everywhere.** 31 cents at 55 Hz, 2 cents at 880.
  Bass lines step audibly. High lines do not.

The tracks are weighted **1-2-4-2** reading up from the film's lower edge, not
the 8-4-2-1 you would reach for today. They sum to 9, so every digit is
reachable, and several have two paintings. 4 is either the single 4 track or
both 2s, and the machine cannot tell them apart.

The relays latch, so pitch persists between neumes, which is why a painted strip
is mostly blank. They are also mechanical and do not move together, so 199 Hz to
200 Hz flips eight tracks and the bank spells frequencies nobody painted for
about ten milliseconds. Changes within one digit are clean. Decimal carries
stumble.

### Amplitude is a light bulb

Level was set by shining a torch bulb at a photoresistor. Filament thermal mass
plus asymmetric cell recovery means no envelope has a sharp attack, and released
notes hang on longer than the drawing says.

## The 30-second guarantee

The printed time field is exactly 300 mm at 10 mm/s, so a sheet is 30.000 s by
construction. 1 cm is 1 second and 1 mm is 100 ms. That is one tenth of the
machine's 100 mm/s film speed. At her speed a Legal sheet would last 3.5
seconds.

Nothing downstream measures millimetres off paper. Four corner fiducials define
a reference rectangle, the extractor solves a homography onto their known
coordinates, and print scale, scan DPI, skew and lens distortion all drop out.
Each sheet carries a QR describing itself, so importing is scan-and-drop and the
app takes its speed from the sheet.

See [`packages/template/README.md`](packages/template/README.md).

## Round trip

Draw in the app, hit **Export PDF**, and you get the same two sheets people draw
on with your lines printed onto them. Print it, let someone mark it up by hand,
scan it back. That works because the app and the printed template share one
geometry module.

## Status

Working: the voice, the printable sheets, in-app drawing and painting, the slide
randomiser, live audio, the projector window, plate reverb, the transport strip,
and PDF export back onto the same template.

Not yet: importing scanned sheets. That is the `vision` package (registration,
extraction, the photocell model), and it is the only missing half of the
workshop loop. You can draw, hear and print. You cannot yet scan back in.

## Releases

Tag and push. GitHub Actions builds macOS, Windows and Linux on their own
runners and publishes a draft release.

```bash
git tag -a v0.1.0 -m "v0.1.0"
git push origin v0.1.0
```

Cross-compiling from one host is possible but fragile, since Windows installers
want wine and Linux AppImages want their own tooling, and those failures surface
late.

To build locally for the current platform only:

```bash
pnpm dist                                          # installers
pnpm --filter @oramics/shell run build:dir         # unpacked app, faster
```

`stage.mjs` copies the Vite build into `packages/shell/renderer` first, so the
packaged app is self-contained. The whole bundle is `main.cjs`, `preload.cjs`
and the renderer, with no `node_modules` at all. Vite has already bundled
everything the renderer uses and the shell has no runtime dependencies, which
avoids the usual pnpm and electron-builder hoisting problems.

The icon is generated rather than committed. `pnpm icon` writes
`packages/shell/build-resources/icon.png` and electron-builder converts it.

### Signing

The macOS build signs and notarises itself when the credentials are present,
and builds unsigned when they are not, so a clone without an Apple account
still works. See `packages/shell/electron-builder.config.js`.

Signing needs a **Developer ID Application** certificate. This is a different
thing from the Apple Development and Apple Distribution certificates Xcode
creates for you: those are for debugging and for the Mac App Store, and neither
one works for a DMG people download. Only the team's Account Holder can create
a Developer ID certificate.

Five repository secrets switch it on:

| Secret | What it is |
|---|---|
| `APPLE_CERT_P12` | The Developer ID certificate, exported as .p12 and base64 encoded |
| `APPLE_CERT_PASSWORD` | The password you set when exporting it |
| `APPLE_ID` | Your Apple ID email |
| `APPLE_APP_SPECIFIC_PASSWORD` | From appleid.apple.com, not your account password |
| `APPLE_TEAM_ID` | The ten-character team identifier |

Notarising matters as much as signing. A signed but unnotarised app is still
blocked on any machine that has not seen it before. The release workflow runs
`codesign`, `spctl` and `stapler validate` afterwards and prints the results,
because the difference is invisible until someone else tries to open it.

Windows builds are unsigned, so SmartScreen shows a warning users can click
through. Certificates now have to live on hardware or in a cloud HSM, which
puts them at roughly $200 to $400 a year.

Until macOS signing is switched on, Gatekeeper refuses the app unless you
right-click and Open once, or run:

```bash
xattr -dr com.apple.quarantine /Applications/Oramics.app
```

## Licence and attribution

GPL-3.0. See [LICENSE](LICENSE).

This is an independent reconstruction. It is not affiliated with the Daphne Oram
Trust, Goldsmiths, or the Science Museum. It is built from published accounts of
the machine, chiefly Graham Wrench's. Every departure from what those accounts
describe is marked in the code and switchable in the app.

## Known environment quirk

On macOS, electron's postinstall sometimes produces a 250 KB `dist` instead of
the real 250 MB one. `extract-zip` does not handle the symlinks inside
`Electron.app` and gives up silently with a zero exit code. You get:

```
Error: Electron failed to install correctly, please delete node_modules/electron
```

The download is fine and already cached. Only the extract failed. Repair it:

```bash
pnpm fix:electron
```

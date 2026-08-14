# @oramics/template

Printable drawing sheets for contributors. US Legal (8.5 × 14"), landscape.

**Two pages per piece.** Page one carries every time-domain lane as a
horizontal band; page two carries the four timbres as one-cycle panels. That is
two things to scan, not thirteen.

```bash
pnpm template                            # the two-page workshop set
pnpm template -- --neumes                # ...plus the binary pitch sheet
pnpm template -- --layout machine        # just the all-lanes page
pnpm template -- --layout slides         # just the four timbres
pnpm template -- --layout solo --roles AMP1,VIB   # one full page per role
pnpm template -- --grid nonphoto         # blue grid, for channel dropout
pnpm template -- --list                  # what roles exist
```

The bands are weighted, not equal: pitch gets roughly twice the height of an
amplitude lane because it is the only one where vertical position has to be read
precisely rather than gesturally. Everything else is a contour between two rails
and survives being 13–19 mm tall.

Two things cannot be bands. The **binary pitch grid** needs twelve bit rows plus
a write-in row, so `--neumes` gives it a page of its own. The **waveform slides**
are phase, not time — they were painted glass, not film — so they get the 2×2
page.

Print at **100% / "Actual size"**. Scaling to fit is survivable — the fiducials
correct for it — but it eats into the printer's dead zone and can clip the
corner marks, which is not.

## The 30-second guarantee

The time field is **exactly 300 mm** wide and the nominal read speed is
**10 mm/s**, so a sheet is **30.000 s** by construction. That also makes
1 cm = 1 s and 1 mm = 100 ms, and it is exactly one tenth of the 100 mm/s film
speed of Oram's machine — a sheet is the Oramics machine at one-tenth speed,
which is the only way a useful duration fits on paper. At her speed a Legal
sheet would last 3.5 seconds.

Nothing downstream measures millimetres off the paper. The four corner
fiducials define a reference rectangle; the extractor solves a homography onto
their known coordinates and works in template space from then on. Print scale,
scan DPI, page skew and lens distortion all fall out. `SHEET_DURATION_S` is the
single source of truth, and `geometry.test.ts` asserts it.

## The sheet describes itself

Each sheet carries a QR encoding version, sheet id, lane number, role,
duration, and the field rectangle relative to the top-left fiducial centre:

```
ORAM1*A3F91C2D*00*MACH*30000*260*180*3000*1660
```

On the combined sheets the role slot holds a *layout* id — `MACH` or `SLID` —
and the band subdivision is looked up from `machineBands()` / `slidePanels()`
for that payload version rather than spelled out in the QR. Eight band
rectangles would not fit, and they are fully determined by the version anyway.
Bump `PAYLOAD_VERSION` if the subdivision ever changes, or old sheets will be
read against the wrong bands.

So importing is scan-and-drop: no manual lane assignment, and the app sets its
transport speed from the sheet rather than the operator setting it by hand. The
geometry travels in the payload rather than being hardcoded in the reader, so a
later template revision can move the field and old sheets still import.

The payload is uppercase alphanumeric only, which keeps it in QR's dense
alphanumeric mode — 46 characters at error-correction level Q is a 29-module
version 3 symbol at 18 mm, about 0.6 mm per module.

## Field kinds

| Kind | Roles | x axis | y axis |
|---|---|---|---|
| `unipolar` | `AMP1-4`, `REV`, `TRN` | time | 0 at bottom rail, 1 at top |
| `bipolar` | `VIB` | time | −1 … +1 about a heavy centre |
| `logpitch` | `PCH` | time | log Hz, 55–880, octaves on round numbers |
| `bcd` | `NEU` | time, 1 s columns | 3 digits × 4 bits, weighted 8 4 2 1 |
| `cycle` | `WAV1-4` | **phase, 0–360°** | −1 … +1 |

Every kind shares the same field rectangle. That is deliberate: the extractor
has one geometry to recover, and the role only decides how values inside it are
read.

`cycle` is the odd one out — the waveform slides were static painted glass, not
moving film, so those sheets are one cycle of a wave rather than a stretch of
time. Their `durationMs` is present in the payload but meaningless.

## Grid styles

`grey` (default) prints the grid at 12–24% black. It survives photocopying,
which is what a workshop actually does to paper, and the extractor separates
drawing from grid by threshold.

`nonphoto` prints it in traditional drafting blue so it can be dropped by
channel instead. Cleaner extraction, but only if sheets go straight from the
printer to the scanner — a photocopier will render the blue as black and the
grid becomes indistinguishable from ink.

## Changing the geometry

`geometry.ts` holds every dimension, in page-millimetres with a top-left origin.
The tests are the guard rails, and they encode constraints that are not obvious
from looking at a page:

- fiducial ink stays ≥ 6.35 mm from the paper edge (printer dead zone)
- no fiducial overlaps the drawing field
- running text starts clear of the corner fiducials
- the QR's **opaque** quiet zone touches neither the field nor a fiducial —
  it is drawn last, so anything it overlaps is erased
- payloads stay inside QR alphanumeric mode and under the 47-character budget

Run `pnpm --filter @oramics/template test` after any change, and look at a
rendered page — the tests catch collisions, not ugliness.

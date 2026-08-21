/**
 * The grey image everything here works on, and the thresholding it needs.
 *
 * No DOM and no Node, for the same reason the engine has none: the package has
 * to run in the renderer against a canvas, in a unit test against a rendered
 * sheet, and one day in a watch folder, without three versions of the maths.
 * Callers hand over pixels; this decides what is ink.
 */

/** Luminance in 0-1, 0 black and 1 white, row-major from the top left. */
export interface Gray {
  data: Float32Array;
  width: number;
  height: number;
}

/**
 * Which channel to read.
 *
 * `luma` is the honest greyscale and the right default. `red` exists for sheets
 * printed with the non-photo blue grid: blue ink is bright in the red channel,
 * so the whole printed grid vanishes before thresholding rather than having to
 * be reasoned about afterwards. It is the same trick drafting film has used
 * since long before any of this.
 */
export type Channel = 'luma' | 'red';

export const fromRgba = (
  data: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  channel: Channel = 'luma',
): Gray => {
  const out = new Float32Array(width * height);
  for (let i = 0, p = 0; i < out.length; i++, p += 4) {
    const r = data[p]!;
    out[i] =
      channel === 'red' ? r / 255 : (0.2126 * r + 0.7152 * data[p + 1]! + 0.0722 * data[p + 2]!) / 255;
  }
  return { data: out, width, height };
};

/** Wrap an already-grey buffer, such as the PGM a scanner or pdftoppm produces. */
export const fromGray8 = (data: Uint8Array, width: number, height: number): Gray => {
  const out = new Float32Array(width * height);
  for (let i = 0; i < out.length; i++) out[i] = data[i]! / 255;
  return { data: out, width, height };
};

export const at = (img: Gray, x: number, y: number): number => {
  const xi = x < 0 ? 0 : x >= img.width ? img.width - 1 : x | 0;
  const yi = y < 0 ? 0 : y >= img.height ? img.height - 1 : y | 0;
  return img.data[yi * img.width + xi]!;
};

/** Bilinear sample, for reading page coordinates that land between pixels. */
export const sample = (img: Gray, x: number, y: number): number => {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const a = at(img, x0, y0);
  const b = at(img, x0 + 1, y0);
  const c = at(img, x0, y0 + 1);
  const d = at(img, x0 + 1, y0 + 1);
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
};

/** Box-filter downscale by an integer factor. Fiducials do not need full resolution. */
export const shrink = (img: Gray, factor: number): Gray => {
  const f = Math.max(1, Math.round(factor));
  if (f === 1) return img;
  const width = Math.floor(img.width / f);
  const height = Math.floor(img.height / f);
  const out = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let acc = 0;
      for (let dy = 0; dy < f; dy++) {
        const row = (y * f + dy) * img.width + x * f;
        for (let dx = 0; dx < f; dx++) acc += img.data[row + dx]!;
      }
      out[y * width + x] = acc / (f * f);
    }
  }
  return { data: out, width, height };
};

/**
 * Otsu's threshold: the split that minimises the variance within each side.
 *
 * Good for a scan, where the page is evenly lit and the histogram genuinely has
 * two humps. A photo taken by hand under a window does not, which is what
 * `localMean` is for.
 */
export const otsu = (img: Gray): number => {
  const bins = 256;
  const hist = new Float64Array(bins);
  for (const v of img.data) hist[Math.min(bins - 1, Math.max(0, Math.round(v * (bins - 1))))]! += 1;

  const total = img.data.length;
  let sum = 0;
  for (let i = 0; i < bins; i++) sum += i * hist[i]!;

  let sumBelow = 0;
  let countBelow = 0;
  let best = 0;
  let bestVariance = -1;
  for (let i = 0; i < bins; i++) {
    countBelow += hist[i]!;
    if (countBelow === 0) continue;
    const countAbove = total - countBelow;
    if (countAbove === 0) break;
    sumBelow += i * hist[i]!;
    const meanBelow = sumBelow / countBelow;
    const meanAbove = (sum - sumBelow) / countAbove;
    const variance = countBelow * countAbove * (meanBelow - meanAbove) ** 2;
    if (variance > bestVariance) {
      bestVariance = variance;
      best = i;
    }
  }
  return best / (bins - 1);
};

/**
 * Local mean brightness over a square window, by integral image.
 *
 * This is the paper, not the ink: a photo of a sheet under a window is half a
 * stop brighter on one side, and a single global threshold either loses the
 * marks in the shadow or turns the highlight into ink. Comparing each pixel
 * against its own neighbourhood removes the gradient entirely.
 */
export const localMean = (img: Gray, radius: number): Gray => {
  const { width: w, height: h, data } = img;
  const stride = w + 1;
  const integral = new Float64Array(stride * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) {
      row += data[y * w + x]!;
      integral[(y + 1) * stride + x + 1] = integral[y * stride + x + 1]! + row;
    }
  }

  const out = new Float32Array(w * h);
  const r = Math.max(1, Math.round(radius));
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r);
    const y1 = Math.min(h, y + r + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r);
      const x1 = Math.min(w, x + r + 1);
      const total =
        integral[y1 * stride + x1]! -
        integral[y0 * stride + x1]! -
        integral[y1 * stride + x0]! +
        integral[y0 * stride + x0]!;
      out[y * w + x] = total / ((y1 - y0) * (x1 - x0));
    }
  }
  return { data: out, width: w, height: h };
};

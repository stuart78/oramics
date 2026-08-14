/**
 * Canvas colours, read back from the CSS tokens.
 *
 * The drawing surfaces paint pixels, so they cannot inherit the theme the way
 * the rest of the interface does. They read the same custom properties the
 * stylesheet defines, which keeps one palette rather than two that drift.
 */

export interface PadPalette {
  bg: string;
  grid: string;
  guide: string;
  ink: string;
  fill: string;
  accent: string;
}

const token = (style: CSSStyleDeclaration, name: string, fallback: string): string =>
  style.getPropertyValue(name).trim() || fallback;

export const readPadPalette = (): PadPalette => {
  const style = getComputedStyle(document.documentElement);
  return {
    bg: token(style, '--pad-bg', '#111013'),
    grid: token(style, '--pad-grid', '#2a2830'),
    guide: token(style, '--pad-guide', '#3d3a45'),
    ink: token(style, '--pad-ink', '#e8e4dd'),
    fill: token(style, '--pad-fill', 'rgba(232,228,221,0.22)'),
    accent: token(style, '--accent', '#ff7a4d'),
  };
};

/** Parse a hex token into RGB, for canvases that blend per pixel. */
export const hexToRgb = (hex: string): [number, number, number] => {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return [0, 0, 0];
  const v = parseInt(m[1]!, 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
};

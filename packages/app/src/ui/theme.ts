/**
 * Theme selection, applied before React renders anything.
 *
 * The drawing surfaces are canvases: they read the palette out of the CSS
 * custom properties at paint time rather than inheriting it. That makes them
 * sensitive to *when* the theme attribute lands. React runs child effects
 * before parent effects, so a parent that sets the attribute in an effect does
 * it too late — every pad has already painted itself from the bare `:root`
 * palette, and nothing marks them dirty afterwards, so they stay the wrong
 * colour until something else forces a repaint.
 *
 * Setting the attribute at module scope, before `createRoot().render()`, sides
 * step the ordering question entirely. The body is empty until React renders,
 * so there is nothing to flash.
 */

export type Theme = 'light' | 'dark';

export const initialTheme = (): Theme =>
  window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark';

export const applyTheme = (theme: Theme): void => {
  document.documentElement.dataset.theme = theme;
};

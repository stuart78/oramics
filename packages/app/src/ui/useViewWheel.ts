/**
 * Wheel zoom and pan for a canvas showing part of the timeline.
 *
 * Attached natively rather than through an `onWheel` prop, because React
 * registers wheel listeners on the root as passive. A passive listener cannot
 * call preventDefault, so the browser would run its own page zoom or scroll on
 * top of ours and the view would jump twice per gesture.
 */

import { useEffect, type RefObject } from 'react';

import { panBy, zoomAt, type View } from './view.js';

export const useViewWheel = (
  ref: RefObject<HTMLCanvasElement | null>,
  view: RefObject<View>,
  onViewChange: (next: View) => void,
): void => {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const onWheel = (event: WheelEvent): void => {
      // A trackpad pinch arrives as a wheel event with ctrlKey set, which is
      // also the shortcut people reach for on a mouse.
      const zooming = event.ctrlKey || event.metaKey;
      const panning = event.shiftKey || Math.abs(event.deltaX) > Math.abs(event.deltaY);
      // Plain vertical scrolling belongs to the page: the lane list is taller
      // than the window and has to stay scrollable.
      if (!zooming && !panning) return;

      event.preventDefault();
      const rect = el.getBoundingClientRect();
      if (zooming) {
        const anchor = (event.clientX - rect.left) / rect.width;
        onViewChange(zoomAt(view.current, anchor, Math.exp(event.deltaY * 0.004)));
      } else {
        const span = view.current.to - view.current.from;
        const delta = (event.shiftKey ? event.deltaY : event.deltaX) / rect.width;
        onViewChange(panBy(view.current, delta * span));
      }
    };

    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [ref, view, onViewChange]);
};

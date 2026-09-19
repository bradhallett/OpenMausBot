import { useRef, useState, type PointerEvent } from "react";

const PANEL_WIDTH_KEY = "omb-computer-panel-width";
export const PANEL_MIN_WIDTH = 360;
export const PANEL_MAX_WIDTH = 960;
const PANEL_DEFAULT_WIDTH = 400;

function readPanelWidth(): number {
  try {
    const stored = Number(localStorage.getItem(PANEL_WIDTH_KEY));
    if (Number.isFinite(stored) && stored >= PANEL_MIN_WIDTH && stored <= PANEL_MAX_WIDTH) return stored;
  } catch {
    /* storage blocked — default width */
  }
  return PANEL_DEFAULT_WIDTH;
}

/** The panel is a fixed column by default; a drag handle on its left edge
 * makes it wide enough to actually read a page in the Browser tab. */
export function usePanelWidth() {
  const [panelWidth, setPanelWidth] = useState(readPanelWidth);
  const resizeFrom = useRef<{ x: number; width: number } | null>(null);
  const persist = (width: number) => {
    try {
      localStorage.setItem(PANEL_WIDTH_KEY, String(width));
    } catch {
      /* storage blocked — width lives for this session */
    }
  };
  const onResizeStart = (event: PointerEvent<HTMLDivElement>) => {
    resizeFrom.current = { x: event.clientX, width: panelWidth };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const onResizeMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!resizeFrom.current) return;
    const next = Math.min(PANEL_MAX_WIDTH, Math.max(PANEL_MIN_WIDTH, resizeFrom.current.width + (resizeFrom.current.x - event.clientX)));
    setPanelWidth(next);
  };
  const onResizeEnd = (event: PointerEvent<HTMLDivElement>) => {
    if (!resizeFrom.current) return;
    resizeFrom.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
    persist(panelWidth);
  };
  /** Keyboard resize: the same clamp and stored preference the pointer flow
   * uses, so arrow-key changes stay in React state like a drag would. */
  const onResizeBy = (delta: number) => {
    setPanelWidth((current) => {
      const next = Math.min(PANEL_MAX_WIDTH, Math.max(PANEL_MIN_WIDTH, current + delta));
      persist(next);
      return next;
    });
  };
  return { panelWidth, onResizeStart, onResizeMove, onResizeEnd, onResizeBy };
}

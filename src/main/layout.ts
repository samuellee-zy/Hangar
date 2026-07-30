import { randomUUID } from 'node:crypto';
import type { Pane } from '../shared/types';

/**
 * Pane geometry. Deliberately dumb: no tree, no resizable splitters, no persisted ratios — just
 * "how do N panes divide whatever the rail leaves behind". A tree buys flexibility nobody asked
 * for; if dragging splitters ever matters, this is the one file that changes.
 *
 * Pure — no Electron import — so all of it is testable under plain node.
 */

export const MAX_PANES = 4;
export const PANE_RADIUS = 10;

/** Height of the strip that hosts the traffic lights when the rail can't. See `chromeFor`. */
export const TOP_STRIP = 38;

export type RailPosition = 'left' | 'right' | 'top' | 'bottom';

export interface Chrome {
  railPosition: RailPosition;
  railSize: number;
  gutter: number;
  /** Reserved at the top of the window for window controls. 0 when the rail already hosts them. */
  topStrip: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * macOS window controls span 52pt and have to live *somewhere*.
 *
 * - **left**: inside the rail, centred horizontally — where they've always been.
 * - **top**: inset at the horizontal rail's left end, which reads as an ordinary toolbar.
 * - **right / bottom**: the rail is nowhere near the top-left, so a slim strip is reserved for
 *   them. It doubles as the window's drag region.
 */
export function chromeFor(railPosition: RailPosition, railSize: number, gutter: number): Chrome {
  const hostsButtons = railPosition === 'left' || railPosition === 'top';
  return { railPosition, railSize, gutter, topStrip: hostsButtons ? 0 : TOP_STRIP };
}

/** Where the window buttons go for a given chrome. Applied with `setWindowButtonPosition`. */
export function windowButtonPosition(chrome: Chrome): { x: number; y: number } {
  const BUTTON_SPAN = 52;
  const BUTTON_HEIGHT = 12;
  if (chrome.railPosition === 'left') {
    return { x: Math.round((chrome.railSize - BUTTON_SPAN) / 2), y: 17 };
  }
  if (chrome.railPosition === 'top') {
    return { x: 14, y: Math.max(6, Math.round((chrome.railSize - BUTTON_HEIGHT) / 2)) };
  }
  return { x: 14, y: Math.round((TOP_STRIP - BUTTON_HEIGHT) / 2) };
}

export function railBounds(chrome: Chrome, width: number, height: number): Rect {
  const { railPosition: pos, railSize, topStrip } = chrome;
  switch (pos) {
    case 'left':
      return { x: 0, y: topStrip, width: railSize, height: height - topStrip };
    case 'right':
      return { x: width - railSize, y: topStrip, width: railSize, height: height - topStrip };
    case 'top':
      return { x: 0, y: 0, width, height: railSize };
    case 'bottom':
      return { x: 0, y: height - railSize, width, height: railSize };
  }
}

/** The area left for panes once the rail and any chrome strip are subtracted. */
export function contentArea(chrome: Chrome, width: number, height: number): Rect {
  const { railPosition: pos, railSize, topStrip } = chrome;
  const top = topStrip;
  switch (pos) {
    case 'left':
      return { x: railSize, y: top, width: width - railSize, height: height - top };
    case 'right':
      return { x: 0, y: top, width: width - railSize, height: height - top };
    case 'top':
      return { x: 0, y: railSize, width, height: height - railSize };
    case 'bottom':
      return { x: 0, y: top, width, height: height - railSize - top };
  }
}

export class Layout {
  panes: Pane[] = [];
  focusedPaneId: string | null = null;

  get isFull(): boolean {
    return this.panes.length >= MAX_PANES;
  }

  find(paneId: string): Pane | undefined {
    return this.panes.find((p) => p.id === paneId);
  }

  focused(): Pane | undefined {
    return this.focusedPaneId ? this.find(this.focusedPaneId) : undefined;
  }

  /** Replaces the focused pane's service — the plain "click a rail icon" case. */
  show(serviceId: string): Pane {
    const focused = this.focused();
    if (focused) {
      focused.serviceId = serviceId;
      return focused;
    }
    return this.add(serviceId);
  }

  add(serviceId: string): Pane {
    if (this.isFull) return this.show(serviceId);
    const pane: Pane = { id: randomUUID(), serviceId };
    this.panes.push(pane);
    this.focusedPaneId = pane.id;
    return pane;
  }

  close(paneId: string): void {
    const index = this.panes.findIndex((p) => p.id === paneId);
    if (index === -1) return;
    // Never close the last pane — the window would be an empty rail with nothing in it.
    if (this.panes.length === 1) return;
    this.panes.splice(index, 1);
    if (this.focusedPaneId === paneId) {
      this.focusedPaneId = this.panes[Math.min(index, this.panes.length - 1)]?.id ?? null;
    }
  }

  cycleFocus(delta: -1 | 1): void {
    if (this.panes.length < 2) return;
    const index = this.panes.findIndex((p) => p.id === this.focusedPaneId);
    const next = (index + delta + this.panes.length) % this.panes.length;
    this.focusedPaneId = this.panes[next]?.id ?? null;
  }

  /**
   * 1 → full bleed · 2 → two columns · 3 → three columns · 4 → 2×2.
   * Columns rather than rows because these are web apps: vertical space is the scarce axis.
   */
  bounds(chrome: Chrome, contentWidth: number, contentHeight: number): Map<string, Rect> {
    const out = new Map<string, Rect>();
    const n = this.panes.length;
    if (n === 0) return out;

    const area = contentArea(chrome, contentWidth, contentHeight);
    const { gutter } = chrome;
    const cols = n === 4 ? 2 : n;
    const rows = n === 4 ? 2 : 1;

    const x0 = area.x + gutter;
    const y0 = area.y + gutter;
    const usableW = Math.max(0, area.width - gutter * (cols + 1));
    const usableH = Math.max(0, area.height - gutter * (rows + 1));

    const cellW = Math.floor(usableW / cols);
    const cellH = Math.floor(usableH / rows);

    this.panes.forEach((pane, i) => {
      const col = i % cols;
      const row = Math.floor(i / cols);
      out.set(pane.id, {
        x: x0 + col * (cellW + gutter),
        y: y0 + row * (cellH + gutter),
        // Last column/row absorbs the rounding remainder so the far gutter stays even.
        width: col === cols - 1 ? usableW - col * cellW : cellW,
        height: row === rows - 1 ? usableH - row * cellH : cellH,
      });
    });

    return out;
  }

  /** Services currently on screen — everything else gets detached. */
  visibleServiceIds(): Set<string> {
    return new Set(this.panes.map((p) => p.serviceId));
  }
}

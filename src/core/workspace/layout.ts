import { randomUUID } from 'node:crypto';
import type { Pane, Rect } from '@shared/types';

// Re-exported because everything geometric here returns one, and `import type { Rect } from
// '@core/workspace/layout'` is where callers naturally look for it. It lives in `@shared` so the
// renderer's drag layer can use it without importing core.
export type { Rect };

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

/**
 * A collapsed compact rail is a strip of icons, wide enough for a 36px tile and its padding.
 *
 * It was briefly a bare chevron with the tiles hidden entirely. That reclaimed the most space and
 * was the worst of the three: switching service became open the rail, click, and the rail is still
 * open, where it had been one click. Chrome's vertical tabs are the reference — collapsed still
 * shows every favicon, so the common action stays a single click and only the labels are traded
 * away.
 */
export const COMPACT_RAIL_SIZE = 48;

/**
 * A compact rail opened by the chevron: icons *and* labels, side by side, the way Chrome's vertical
 * tab strip expands. Wide enough for a service name to read rather than ellipsise, which is the
 * only reason to open it at all.
 *
 * 240 was tried first, copied from Chrome, and read as mostly empty. Chrome is sizing for page
 * titles — "Q3 planning review — Google Docs" — where these are service names: Gmail, Calendar,
 * Slack. 180 fits every name in the catalog with room to spare and gives 60px back to the pane.
 */
export const EXPANDED_RAIL_SIZE = 180;

/**
 * A rail has two thicknesses: what the panes give up (`reserved`) and what the rail view occupies
 * (`rail`).
 *
 * They are always equal. A compact rail collapses to the chevron strip and grows back to the full
 * preference when the chevron is clicked, and the panes reflow around it both times.
 *
 * They were *not* always equal: an earlier compact rail expanded on hover and floated over the
 * panes so nothing reflowed under the cursor. That traded one problem for two. A view sitting over
 * a pane hit-tests across its own bounds, so the overlap swallowed clicks meant for the page; and
 * collapsing depended on the rail's renderer seeing `pointerleave`, which Chromium does not
 * reliably deliver when the pointer crosses into a sibling `WebContentsView` — so the rail would
 * stand open over the pane indefinitely. Expansion is a click now, and reflow means the rail is
 * never over a pane to begin with.
 *
 * `expanded` is ignored unless the rail is compact, so the caller doesn't have to remember to
 * clear it, and expansion can never make the rail *narrower* than the strip it grew from.
 */
export function railSizes(
  appearance: { railSize: number; compactRail: boolean },
  expanded: boolean,
): { reserved: number; rail: number } {
  if (!appearance.compactRail) return { reserved: appearance.railSize, rail: appearance.railSize };
  const size = expanded ? Math.max(EXPANDED_RAIL_SIZE, appearance.railSize) : COMPACT_RAIL_SIZE;
  return { reserved: size, rail: size };
}

export type RailPosition = 'left' | 'right' | 'top' | 'bottom';

export interface Chrome {
  railPosition: RailPosition;
  railSize: number;
  gutter: number;
  /** Reserved at the top of the window for window controls. 0 when the rail already hosts them. */
  topStrip: number;
}

/** macOS traffic lights span this much, and cannot be made smaller. */
const BUTTON_SPAN = 52;

/**
 * macOS window controls have to live *somewhere*.
 *
 * - **left**: inside the rail, centred horizontally — where they've always been.
 * - **top**: inset at the horizontal rail's left end, which reads as an ordinary toolbar.
 * - **right / bottom, or any rail too narrow to hold them**: a slim strip is reserved at the top of
 *   the window. It doubles as the window's drag region.
 *
 * `smallestRailSize` is what the rail can shrink to, and defaults to the size it is now. A compact
 * rail passes its collapsed width so the answer doesn't change when it opens: a 52pt span does not
 * fit a 48px rail, and deciding per-size would move the traffic lights into the rail and drop the
 * strip on every toggle, shifting every pane down the window and back.
 */
export function chromeFor(
  railPosition: RailPosition,
  railSize: number,
  gutter: number,
  smallestRailSize: number = railSize,
): Chrome {
  const hostsButtons =
    (railPosition === 'left' || railPosition === 'top') && smallestRailSize >= BUTTON_SPAN;
  return {
    railPosition,
    railSize,
    gutter,
    topStrip: hostsButtons ? 0 : TOP_STRIP,
  };
}

/**
 * Where the window buttons go for a given chrome. Applied with `setWindowButtonPosition`.
 *
 * Keyed off `topStrip` rather than re-deciding from the rail position and size, so the strip and
 * the buttons can't disagree about which of them is holding the traffic lights.
 */
export function windowButtonPosition(chrome: Chrome): { x: number; y: number } {
  const BUTTON_HEIGHT = 12;
  if (chrome.topStrip > 0) return { x: 14, y: Math.round((TOP_STRIP - BUTTON_HEIGHT) / 2) };
  if (chrome.railPosition === 'left') {
    return { x: Math.round((chrome.railSize - BUTTON_SPAN) / 2), y: 17 };
  }
  return {
    x: 14,
    y: Math.max(6, Math.round((chrome.railSize - BUTTON_HEIGHT) / 2)),
  };
}

export function railBounds(chrome: Chrome, width: number, height: number): Rect {
  const { railPosition: pos, railSize, topStrip } = chrome;
  switch (pos) {
    case 'left':
      return { x: 0, y: topStrip, width: railSize, height: height - topStrip };
    case 'right':
      return {
        x: width - railSize,
        y: topStrip,
        width: railSize,
        height: height - topStrip,
      };
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
      return {
        x: railSize,
        y: top,
        width: width - railSize,
        height: height - top,
      };
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

    // No usable focus — `focusedPaneId` is null, or names a pane that no longer exists.
    //
    // When full this used to call `add()`, which calls straight back here because it is full: two
    // functions mutually recursive with no base case, and a hung main process at the bottom of it.
    // Every caller happened to make it unreachable, which is not the same as it being safe. Reuse
    // the first pane instead, which is what `show` means when there is nowhere new to put it.
    if (this.isFull) {
      const first = this.panes[0];
      if (first) {
        first.serviceId = serviceId;
        this.focusedPaneId = first.id;
        return first;
      }
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
    this.refocusAfter(index, paneId);
  }

  /**
   * Removes a pane including the last one, which `close()` refuses.
   *
   * That refusal is a UI policy — ⌘W on the last pane closes the window instead. Retargeting an
   * orphaned pane needs the other answer: with no service left to show, the pane has to go so the
   * empty state can take over. This exists so that path doesn't reach for `panes` directly and
   * skip the focus fixup below.
   */
  dropPane(paneId: string): void {
    const index = this.panes.findIndex((p) => p.id === paneId);
    if (index === -1) return;
    this.panes.splice(index, 1);
    this.refocusAfter(index, paneId);
  }

  /** Keeps `focusedPaneId` naming a pane that exists. Every removal path must end here. */
  private refocusAfter(index: number, removedId: string): void {
    if (this.focusedPaneId !== removedId) return;
    this.focusedPaneId = this.panes[Math.min(index, this.panes.length - 1)]?.id ?? null;
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

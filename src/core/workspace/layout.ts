import { randomUUID } from 'node:crypto';
import type { Pane, Rect } from '@shared/types';
import {
  COMPACT_RAIL_SIZE,
  TOP_STRIP,
  WINDOW_BUTTON_SPAN,
  railCanExpand,
  railHostsWindowButtons,
  type RailPosition,
} from '@shared/chrome';

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

// Shared with the rail's renderer, which has to agree with this file about where the traffic
// lights are. Re-exported because this is where the geometry's callers look for them.
export { COMPACT_RAIL_SIZE, TOP_STRIP, type RailPosition };

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
 * `expanded` is ignored unless the rail is compact and vertical (see `railCanExpand`), so the
 * caller doesn't have to remember to clear it, and expansion can never make the rail *narrower*
 * than the strip it grew from.
 */
export function railSizes(
  appearance: { railSize: number; compactRail: boolean; railPosition?: RailPosition },
  expanded: boolean,
): { reserved: number; rail: number } {
  if (!appearance.compactRail) return { reserved: appearance.railSize, rail: appearance.railSize };
  const canExpand = railCanExpand({ compactRail: true, railPosition: appearance.railPosition ?? 'left' });
  const size =
    expanded && canExpand ? Math.max(EXPANDED_RAIL_SIZE, appearance.railSize) : COMPACT_RAIL_SIZE;
  return { reserved: size, rail: size };
}

export interface Chrome {
  railPosition: RailPosition;
  railSize: number;
  gutter: number;
  /** Reserved at the top of the window for window controls. 0 when the rail already hosts them. */
  topStrip: number;
}

/**
 * macOS window controls have to live *somewhere*.
 *
 * - **left**: inside the rail, centred horizontally — where they've always been.
 * - **top**: inset at the horizontal rail's left end, which reads as an ordinary toolbar. Compact
 *   too: the span runs along the rail, so a thin one holds them as well as a thick one. It used to
 *   hand them to the strip like a narrow left rail — but a top rail *is* the top of the window, so
 *   no strip was ever reserved, and they were drawn over the first two tiles.
 * - **right / bottom, or a left rail too narrow to hold them**: a slim strip is reserved at the top
 *   of the window. It doubles as the window's drag region.
 *
 * `smallestRailSize` is what the rail can shrink to, and defaults to the size it is now. A compact
 * rail passes its collapsed width so the answer doesn't change when it opens. The decision itself
 * is `railHostsWindowButtons`, shared with the renderer that has to leave room for them.
 */
export function chromeFor(
  railPosition: RailPosition,
  railSize: number,
  gutter: number,
  smallestRailSize: number = railSize,
): Chrome {
  const hostsButtons = railHostsWindowButtons(railPosition, smallestRailSize);
  return {
    railPosition,
    railSize,
    gutter,
    topStrip: hostsButtons ? 0 : TOP_STRIP,
  };
}

/** The traffic lights' size: the whole span of the three, and the height of one. */
export interface WindowButtonMetrics {
  span: number;
  height: number;
}

/** Every macOS before 26. Main measures the real ones; see `windowButtonMetrics`. */
export const CLASSIC_WINDOW_BUTTONS: WindowButtonMetrics = { span: WINDOW_BUTTON_SPAN, height: 12 };

/**
 * Where the window buttons go for a given chrome. Applied with `setWindowButtonPosition`.
 *
 * Keyed off `topStrip` rather than re-deciding from the rail position and size, so the strip and
 * the buttons can't disagree about which of them is holding the traffic lights.
 */
export function windowButtonPosition(
  chrome: Chrome,
  buttons: WindowButtonMetrics = CLASSIC_WINDOW_BUTTONS,
): { x: number; y: number } {
  if (chrome.topStrip > 0) return { x: 14, y: Math.round((TOP_STRIP - buttons.height) / 2) };
  if (chrome.railPosition === 'left') {
    return { x: Math.max(0, Math.round((chrome.railSize - buttons.span) / 2)), y: 17 };
  }
  // Centred in the rail's height, at its left end.
  return {
    x: 14,
    y: Math.max(6, Math.round((chrome.railSize - buttons.height) / 2)),
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
  /**
   * One pane filling the content area on its own, the others kept but not drawn — the split
   * survives, it is just out of the way. Follows focus: cycling panes while maximised shows the
   * next one full size. Not persisted; it is a momentary view, like a zoomed window.
   */
  maximisedPaneId: string | null = null;

  /** Toggles maximise on the focused pane. Meaningless with one pane, so it clears instead. */
  toggleMaximise(): void {
    this.maximisedPaneId =
      this.maximisedPaneId || this.panes.length < 2 ? null : (this.focusedPaneId ?? null);
  }

  /** The panes actually drawn: the maximised one alone, or all of them. */
  drawn(): Pane[] {
    const maximised = this.maximisedPaneId ? this.find(this.maximisedPaneId) : undefined;
    return maximised && this.panes.length > 1 ? [maximised] : this.panes;
  }

  /** Services in a pane that is drawn — what someone could be looking at. */
  drawnServiceIds(): Set<string> {
    return new Set(this.drawn().map((p) => p.serviceId));
  }

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

  /** A new pane, at the end — or beside a given pane, on the side a drop landed. */
  add(serviceId: string, beside?: { paneId: string; side: 'before' | 'after' }): Pane {
    if (this.isFull) return this.show(serviceId);
    // Opening a pane alongside is asking for the split back.
    this.maximisedPaneId = null;
    const pane: Pane = { id: randomUUID(), serviceId };
    const at = beside ? this.panes.findIndex((p) => p.id === beside.paneId) : -1;
    if (at === -1) this.panes.push(pane);
    else this.panes.splice(beside!.side === 'before' ? at : at + 1, 0, pane);
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
    if (this.maximisedPaneId === removedId || this.panes.length < 2) this.maximisedPaneId = null;
    if (this.focusedPaneId !== removedId) return;
    this.focusedPaneId = this.panes[Math.min(index, this.panes.length - 1)]?.id ?? null;
  }

  cycleFocus(delta: -1 | 1): void {
    if (this.panes.length < 2) return;
    const index = this.panes.findIndex((p) => p.id === this.focusedPaneId);
    const next = (index + delta + this.panes.length) % this.panes.length;
    this.focusedPaneId = this.panes[next]?.id ?? null;
    if (this.maximisedPaneId) this.maximisedPaneId = this.focusedPaneId;
  }

  /**
   * 1 → full bleed · 2 → two columns · 3 → three columns · 4 → 2×2.
   * Columns rather than rows because these are web apps: vertical space is the scarce axis.
   */
  bounds(chrome: Chrome, contentWidth: number, contentHeight: number): Map<string, Rect> {
    const out = new Map<string, Rect>();
    const panes = this.drawn();
    const n = panes.length;
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

    panes.forEach((pane, i) => {
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

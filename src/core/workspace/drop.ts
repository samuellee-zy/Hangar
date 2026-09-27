import type { Rect } from '@shared/types';

/**
 * Where a dragged rail tile would land.
 *
 * Pure, so the geometry can be tested without a window — which matters more here than usual,
 * because the thing being tested is invisible: a drop target is a rectangle nobody draws until the
 * drag is already happening, and afterwards "it landed in the wrong pane" is indistinguishable
 * from "it ignored me".
 *
 * ## Why this exists at all
 *
 * Dropping a tile onto a pane crosses a `webContents` boundary, which Electron does not support —
 * decisions #10, and the reason this sat in the backlog with "not possible" beside it. That framing
 * was slightly wrong. What can't be done is *continuing a drag into another renderer*; what can be
 * done is refusing to let the renderers decide anything. Both the rail and the drag layer report
 * "the pointer is here", in their own coordinates, and main — which owns the pane geometry
 * already — is the only party that works out what that means. See `main/features/drag-layer.ts`.
 */

export interface PaneTarget {
  paneId: string;
  rect: Rect;
}

/**
 * What a drop at a given point does.
 *
 * `replace` swaps the service shown in an existing pane. `new-pane` opens one alongside — the
 * answer when the pointer is over the content area but not over any pane, which happens in the
 * gutters and, more usefully, in the empty remainder left by a single pane. `none` cancels.
 */
export type Drop =
  | { kind: 'replace'; paneId: string }
  /** `beside`: next to that pane, on that side — the edge zones. Absent, at the end. */
  | { kind: 'new-pane'; beside?: { paneId: string; side: 'before' | 'after' } }
  | { kind: 'none' };

/**
 * How far in from a pane's left or right edge a drop opens beside it rather than replacing it: a
 * quarter of the pane, capped. Opening beside used to be only the 6px gutter between panes — and
 * with one pane there is no gutter at all, so "open alongside" was all but unreachable.
 */
export function edgeZone(paneWidth: number): number {
  return Math.min(120, paneWidth / 4);
}

export interface DropContext {
  /** The area panes are laid out inside. A point outside it is over the rail or the chrome. */
  content: Rect;
  panes: readonly PaneTarget[];
  /**
   * Whether there is room for another pane. A boolean rather than a count compared against
   * `MAX_PANES`, so the cap stays a thing only `Layout` decides.
   */
  canOpenNewPane: boolean;
}

export function contains(rect: Rect, x: number, y: number): boolean {
  return x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height;
}

/**
 * The pane under a point, or null.
 *
 * Iterates in reverse so the topmost pane wins where rectangles overlap. They don't today —
 * `Layout.bounds` tiles them with gutters between — but "last one added is on top" is the rule
 * everywhere else here, and quietly disagreeing would be a bug that surfaces the day someone adds
 * resizable splitters.
 */
export function paneAt(panes: readonly PaneTarget[], x: number, y: number): string | null {
  for (let i = panes.length - 1; i >= 0; i--) {
    const pane = panes[i];
    if (pane && contains(pane.rect, x, y)) return pane.paneId;
  }
  return null;
}

export function dropAt(context: DropContext, x: number, y: number): Drop {
  if (!contains(context.content, x, y)) return { kind: 'none' };

  const paneId = paneAt(context.panes, x, y);
  if (paneId) {
    const rect = context.panes.find((p) => p.paneId === paneId)!.rect;
    const zone = edgeZone(rect.width);
    if (context.canOpenNewPane && x < rect.x + zone) return { kind: 'new-pane', beside: { paneId, side: 'before' } };
    if (context.canOpenNewPane && x >= rect.x + rect.width - zone) {
      return { kind: 'new-pane', beside: { paneId, side: 'after' } };
    }
    return { kind: 'replace', paneId };
  }

  // In a gutter, or in the unused remainder. Opening alongside is the useful reading — the pointer
  // is over the content area and not over anything in particular — but only while there is room,
  // or the drop silently replaces a pane the user wasn't aiming at.
  return context.canOpenNewPane ? { kind: 'new-pane' } : { kind: 'none' };
}

/**
 * The rectangle to highlight, so the user knows what releasing will do before they release. Null
 * when nothing would happen, which is itself the feedback.
 */
export function highlightFor(drop: Drop, context: DropContext): Rect | null {
  if (drop.kind === 'none') return null;
  if (drop.kind === 'new-pane') {
    if (!drop.beside) return context.content;
    // The half of that pane the new one would take, so the preview is the answer: here.
    const rect = context.panes.find((p) => p.paneId === drop.beside!.paneId)?.rect;
    if (!rect) return context.content;
    const half = Math.round(rect.width / 2);
    return drop.beside.side === 'before' ? { ...rect, width: half } : { ...rect, x: rect.x + rect.width - half, width: half };
  }
  return context.panes.find((p) => p.paneId === drop.paneId)?.rect ?? null;
}

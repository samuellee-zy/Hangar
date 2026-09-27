import type { BaseWindow, WebContents } from 'electron';
import { loadConfig } from '@main/platform/config';
import { safeSend } from '@main/platform/safe-send';
import type { DragLayer } from '@main/features/drag-layer';
import { dropAt, highlightFor, type DropContext } from '@core/workspace/drop';
import { contentArea, type Chrome, type Layout, type Rect } from '@core/workspace/layout';
import type { DragOrigin } from '@shared/types';

/**
 * Dragging a rail tile onto a pane: the lift, the highlight as it moves, and the drop.
 *
 * Panes are separate `WebContentsView`s and Electron can't drag across them, so the lift attaches a
 * transparent layer over the content area and the pointer passes from the rail into that one
 * renderer and no further (`features/drag-layer.ts`). Both report positions in their own client
 * coordinates, and only this knows where each sits in the window.
 */
export interface DragHost {
  readonly win: BaseWindow;
  readonly layout: Layout;
  readonly dragLayer: DragLayer;
  chrome(): Chrome;
  railRect(width: number, height: number): Rect;
  railContents(): WebContents;
  openService(serviceId: string, options?: { newPane?: boolean }): void;
  flash(serviceId: string): void;
}

/** Why a drag stopped. Only a drop is the user finishing it; the rest are reported in the log. */
export type DragEndReason = 'drop' | 'cancel' | 'relayout' | 'teardown';

export class TileDrag {
  /**
   * The geometry a drag is judged against, frozen at the lift.
   *
   * Frozen rather than recomputed per pointer move, and safe because `relayout()` ends any drag in
   * progress — geometry shifting mid-drag would mean the highlight and the drop disagree, and the
   * user only ever sees the highlight.
   */
  private context: (DropContext & { railOrigin: Rect }) | null = null;

  constructor(private readonly host: DragHost) {}

  /** A rail tile was lifted. Freeze the geometry and hand the content area to the drag layer. */
  begin(serviceId: string): void {
    if (!loadConfig().services.some((s) => s.id === serviceId)) return;
    const { win, layout } = this.host;
    const { width, height } = win.getContentBounds();
    const chrome = this.host.chrome();
    const bounds = layout.bounds(chrome, width, height);
    const content = contentArea(chrome, width, height);

    this.context = {
      content,
      panes: layout.panes.flatMap((pane) => {
        const rect = bounds.get(pane.id);
        return rect ? [{ paneId: pane.id, rect }] : [];
      }),
      // Whether another pane is possible is Layout's to say — a renderer re-deriving it from
      // `MAX_PANES` would be a second copy of a rule only one of them enforces.
      canOpenNewPane: !layout.isFull,
      // The rail view's own rectangle, not the space the panes reserved for it. An expanded
      // compact rail on the right edge starts further left than the reservation says, and every
      // `from: 'rail'` position is translated through this.
      railOrigin: this.host.railRect(width, height),
    };
    this.host.dragLayer.begin(serviceId, content);
  }

  /**
   * A pointer position from one of the two renderers, in that renderer's own client coordinates.
   *
   * Translating here is the whole point of the arrangement: neither surface knows where it sits in
   * the window, and only one of them needs to.
   */
  private point(from: DragOrigin, x: number, y: number): { x: number; y: number } | null {
    const context = this.context;
    if (!context) return null;
    const origin = from === 'rail' ? context.railOrigin : context.content;
    return { x: origin.x + x, y: origin.y + y };
  }

  move(from: DragOrigin, x: number, y: number): void {
    const context = this.context;
    const point = this.point(from, x, y);
    if (!context || !point) return;
    const drop = dropAt(context, point.x, point.y);
    const rect = highlightFor(drop, context);
    this.host.dragLayer.highlight(
      rect && drop.kind !== 'none'
        ? {
            // Into the layer's coordinates. It sits exactly on the content area, so this is the
            // same translation as above, backwards.
            rect: { ...rect, x: rect.x - context.content.x, y: rect.y - context.content.y },
            kind: drop.kind,
          }
        : null,
    );
  }

  /**
   * Detaches the layer and reports which service was in flight, or null if none was.
   *
   * Every exit from a drag comes through here, including the ones nobody asked for — a relayout, a
   * teardown. The rail is told each time, because its dnd-kit drag may never see the release: if
   * the pointer ended up over the layer's renderer, the rail is left holding a lifted tile with no
   * way to put it down.
   */
  end(reason: DragEndReason): string | null {
    const serviceId = this.host.dragLayer.draggingServiceId;
    this.host.dragLayer.end();
    this.context = null;
    if (serviceId) {
      // Logged, because an end nobody asked for is otherwise indistinguishable from a mis-aimed
      // drop: the tile just lands back where it was.
      if (reason !== 'drop') console.log(`[drag] ended by ${reason}`);
      safeSend(this.host.railContents(), 'drag:ended', null);
    }
    return serviceId;
  }

  /**
   * The release. Which service is in flight comes from the layer, never from the message: the drag
   * is main's state, and a `drop-tile` for a tile that was never lifted should do nothing at all.
   */
  drop(from: DragOrigin, x: number, y: number): void {
    const context = this.context;
    const point = this.point(from, x, y);
    // A null service means this is the second message for one drag — typically the rail's own
    // drag-end arriving after the layer already handled the release.
    const serviceId = this.end('drop');
    if (!serviceId || !context || !point) return;

    const target = dropAt(context, point.x, point.y);
    if (target.kind === 'replace') {
      // Focus the pane, then open *without* `newPane`: `Layout.show` replaces the focused pane's
      // service, which is exactly "drop here" once the right pane is focused.
      if (!this.host.layout.find(target.paneId)) return;
      this.host.layout.focusedPaneId = target.paneId;
      this.host.openService(serviceId);
      this.host.flash(serviceId);
    } else if (target.kind === 'new-pane') {
      this.host.openService(serviceId, { newPane: true });
      this.host.flash(serviceId);
    }
  }
}

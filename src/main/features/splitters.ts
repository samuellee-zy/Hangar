import path from 'node:path';
import { WebContentsView, type BaseWindow, type View, type WebContents } from 'electron';
import { loadRoute } from '@main/platform/renderer-url';
import type { Boundary } from '@core/workspace/layout';
import type { Rect } from '@shared/types';

/**
 * The handles between pane columns, or between rows, one thin view per boundary. One of these for
 * each axis: columns load `#splitter-N`, rows `#splitter-row-N`.
 *
 * A gutter is bare window background: nothing is drawn there that could take a pointer — a
 * `View` in Electron has no mouse events — so a splitter has to be a renderer of its own, sat on
 * the gutter. Kept to exactly as many as there are boundaries (none with one column), so a single
 * pane costs nothing.
 *
 * The renderer reports only where the pointer is, like the rail during a drag; main owns the
 * geometry and turns that into column widths (`Layout.resizeAt`). In *screen* coordinates, unlike
 * the rail: this view moves with the boundary it is dragging, so a client position would be measured
 * from wherever the view happened to be when the event was made — a frame behind — and the boundary
 * would chase its own tail.
 *
 * A drag never re-attaches these views. macOS sends the rest of a press to the view that took the
 * mouse-down, and taking that view off the window mid-gesture ends it; see `raiseAbove`.
 */

/** Thicker than a 6px gutter, so it can be found with a pointer; overlaps each pane by a hair. */
const HIT_WIDTH = 10;

export type SplitAxis = 'column' | 'row';

export class Splitters {
  /**
   * Every splitter view made so far; the first `attached` are on the window. Kept rather than
   * closed when the columns drop, so opening and closing a pane doesn't start and stop a renderer
   * each time — and a view closed while its page was still loading logged a failed load.
   */
  private pool: WebContentsView[] = [];
  private attached = 0;

  constructor(
    private readonly win: BaseWindow,
    private readonly onViewCreated: (wc: WebContents) => void,
    private readonly axis: SplitAxis = 'column',
  ) {}

  /** One view per boundary, placed on it. */
  sync(boundaries: readonly Boundary[]): void {
    while (this.attached > boundaries.length) {
      this.attached--;
      this.win.contentView.removeChildView(this.pool[this.attached]!);
    }
    while (this.attached < boundaries.length) {
      const view = this.pool[this.attached] ?? this.create(this.attached);
      this.win.contentView.addChildView(view);
      this.attached++;
    }
    boundaries.forEach(({ rect }, i) => {
      let hit: Rect;
      if (this.axis === 'column') {
        const width = Math.max(HIT_WIDTH, rect.width);
        hit = { x: Math.round(rect.x + rect.width / 2 - width / 2), y: rect.y, width, height: rect.height };
      } else {
        const height = Math.max(HIT_WIDTH, rect.height);
        hit = { x: rect.x, y: Math.round(rect.y + rect.height / 2 - height / 2), width: rect.width, height };
      }
      this.pool[i]!.setBounds(hit);
    });
  }

  private create(index: number): WebContentsView {
    const view = new WebContentsView({
      webPreferences: {
        preload: path.join(__dirname, '../preload/sidebar.cjs'),
        contextIsolation: true,
        // Explicit rather than left to the default: these views hold the app's bridge (decisions #97).
        sandbox: true,
      },
    });
    view.setBackgroundColor('#00000000');
    loadRoute(view.webContents, this.axis === 'column' ? `splitter-${index}` : `splitter-row-${index}`);
    this.onViewCreated(view.webContents);
    this.pool[index] = view;
    return view;
  }

  /**
   * Back above the panes — which a relayout re-adds on top of everything, every time, so after one
   * this always has something to do. It's the caller that keeps a splitter mid-drag where it is, by
   * not asking. `addChildView` on an existing child moves it to the top.
   */
  raiseAbove(panes: ReadonlySet<View>): void {
    if (!this.attached) return;
    const children = this.win.contentView.children;
    const onWindow = this.pool.slice(0, this.attached);
    const lowest = Math.min(...onWindow.map((view) => children.indexOf(view)));
    if (children.slice(lowest + 1).some((child) => panes.has(child))) {
      for (const view of onWindow) this.win.contentView.addChildView(view);
    }
  }

  /**
   * Teardown: the views are kept between uses, so they have to be closed here.
   *
   * This runs on `closed`, when the window is already destroyed and has let go of its children —
   * and asking a destroyed window to detach one throws. It did, with two panes open: `dispose` stopped
   * at the throw, the window's handle was never cleared, and no window could be shown again.
   */
  destroy(): void {
    if (!this.win.isDestroyed()) this.sync([]);
    this.attached = 0;
    for (const view of this.pool) if (!view.webContents.isDestroyed()) view.webContents.close();
    this.pool = [];
  }
}

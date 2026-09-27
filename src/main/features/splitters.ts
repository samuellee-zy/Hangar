import path from 'node:path';
import { WebContentsView, type BaseWindow, type View } from 'electron';
import { loadRoute } from '@main/platform/renderer-url';
import type { Boundary } from '@core/workspace/layout';
import type { Rect } from '@shared/types';

/**
 * The handles between pane columns, one thin view per boundary.
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

/** Wider than a 6px gutter, so it can be found with a pointer; overlaps each pane by a hair. */
const HIT_WIDTH = 10;

export class Splitters {
  /**
   * Every splitter view made so far; the first `attached` are on the window. Kept rather than
   * closed when the columns drop, so opening and closing a pane doesn't start and stop a renderer
   * each time — and a view closed while its page was still loading logged a failed load.
   */
  private pool: WebContentsView[] = [];
  private attached = 0;

  constructor(private readonly win: BaseWindow) {}

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
      const width = Math.max(HIT_WIDTH, rect.width);
      const hit: Rect = { x: Math.round(rect.x + rect.width / 2 - width / 2), y: rect.y, width, height: rect.height };
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
    loadRoute(view.webContents, `splitter-${index}`);
    this.pool[index] = view;
    return view;
  }

  /**
   * Back above the panes, which a relayout re-adds on top — but only if one of them is above a
   * splitter now, so the relayouts that move nothing (the 30-second sweep, a state change) leave a
   * splitter mid-drag where it is. `addChildView` on an existing child moves it to the top.
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

  /** Teardown: the views are kept between uses, so they have to be closed here. */
  destroy(): void {
    this.sync([]);
    for (const view of this.pool) if (!view.webContents.isDestroyed()) view.webContents.close();
    this.pool = [];
  }
}

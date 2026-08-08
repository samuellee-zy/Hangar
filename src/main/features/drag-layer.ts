import path from 'node:path';
import { WebContentsView, type BaseWindow } from 'electron';
import { loadRoute } from '@main/platform/renderer-url';
import { safeSend } from '@main/platform/safe-send';
import type { DropHighlight, Rect } from '@shared/types';

/**
 * The surface that makes dragging a rail tile onto a pane possible.
 *
 * ## The problem it solves
 *
 * Panes are separate `webContents`, and a drag cannot cross that boundary — decisions #10, which is
 * why this sat in the backlog marked "not possible". The framing was slightly wrong. A drag can't
 * *travel* between renderers, but nothing says a renderer has to be the one deciding anything: the
 * rail and this layer each report where the pointer is, in their own coordinates, and main — which
 * owns the pane rectangles already — works out what a release there would do.
 *
 * That inversion is what makes it robust. Whether the pointer events keep going to the rail after
 * the press (mouse capture, which is the macOS behaviour) or start arriving here once the cursor
 * crosses over, main sees the same stream either way and this layer never has to care which.
 *
 * So this view has no logic in it at all. It draws the rectangle it is told to draw, and forwards
 * pointer events it happens to receive.
 *
 * ## Why it isn't attached the rest of the time
 *
 * A transparent `WebContentsView` hit-tests across its whole bounds — the same fact that rules out
 * a full-window overlay for the find bar. Leaving it attached would swallow every click and scroll
 * in every pane. It exists only between `begin()` and `end()`, and `end()` has to run on every path
 * out of a drag, including cancellation, a relayout, and the window being torn down.
 */
export class DragLayer {
  private view: WebContentsView | null = null;
  private attached = false;
  /** The tile in flight. Null when no drag is in progress, which is the authoritative check. */
  private serviceId: string | null = null;

  constructor(private win: BaseWindow) {}

  get draggingServiceId(): string | null {
    return this.serviceId;
  }

  private ensure(): WebContentsView {
    if (this.view) return this.view;
    this.view = new WebContentsView({
      webPreferences: {
        preload: path.join(__dirname, '../preload/sidebar.cjs'),
        contextIsolation: true,
      },
    });
    // Fully transparent: the panes underneath have to stay visible, or the user is aiming at a grey
    // rectangle rather than at their own windows.
    this.view.setBackgroundColor('#00000000');
    loadRoute(this.view.webContents, 'drag');
    return this.view;
  }

  /**
   * Takes over the content area for a drag.
   *
   * `content` is where the layer sits, and is also the origin every `from: 'content'` position is
   * relative to — the renderer only ever knows its own client rectangle.
   */
  begin(serviceId: string, content: Rect): void {
    const view = this.ensure();
    this.serviceId = serviceId;
    if (!this.attached) {
      this.win.contentView.addChildView(view);
      this.attached = true;
    }
    view.setBounds(content);
    // Clear whatever the last drag left on screen before this one can be seen.
    this.highlight(null);
    // Focus, so Escape reaches this view rather than whatever held the keyboard before the lift. A
    // drag that can only end by committing is a trap, and this view is covering every pane.
    view.webContents.focus();
  }

  /** Draws the drop indicator, in the layer's own coordinates. Null erases it. */
  highlight(highlight: DropHighlight | null): void {
    if (!this.view) return;
    safeSend(this.view.webContents, 'drag:highlight', highlight);
  }

  /**
   * Releases the content area.
   *
   * Idempotent, and safe on a destroyed window: it is called from the drop, from a cancel, from a
   * relayout and from teardown, and any one of those can be the second to arrive.
   */
  end(): void {
    this.serviceId = null;
    if (!this.attached || !this.view) return;
    this.highlight(null);
    try {
      this.win.contentView.removeChildView(this.view);
    } catch {
      // The window is already destroyed, which detached it for us.
    }
    this.attached = false;
  }

  /**
   * Teardown. As with the overlay and the find bar, `end()` only detaches and the view is kept for
   * the next drag, so a view that has been used once outlives the window unless it is closed.
   */
  destroy(): void {
    this.end();
    if (!this.view) return;
    if (!this.view.webContents.isDestroyed()) this.view.webContents.close();
    this.view = null;
  }
}

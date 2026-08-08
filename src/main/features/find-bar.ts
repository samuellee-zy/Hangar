import path from 'node:path';
import { WebContentsView, type BaseWindow } from 'electron';
import { loadRoute } from '@main/platform/renderer-url';
import { safeSend } from '@main/platform/safe-send';
import type { Rect } from '@core/workspace/layout';

/**
 * Find in page.
 *
 * Deliberately **not** the overlay layer. A transparent `WebContentsView` hit-tests across its whole
 * bounds, so a full-window overlay would block clicking and scrolling the very page you're
 * searching — the one interaction find has to leave working. So this is a small view sized to the
 * bar itself, parked in the top-right of the focused pane.
 *
 * Electron's `findInPage` is per-`webContents`, which suits panes exactly: each search targets the
 * focused pane and nothing else.
 */

const WIDTH = 340;
const HEIGHT = 46;
const MARGIN = 12;

export class FindBar {
  private view: WebContentsView | null = null;
  private attached = false;
  /** The contents currently being searched, so we can stop cleanly when closing. */
  private target: Electron.WebContents | null = null;
  /**
   * Which service that belongs to. Focus can move while the bar is open, and the bar follows the
   * focused pane on relayout — so the caller needs to notice when the two have diverged.
   */
  private targetService: string | null = null;

  constructor(
    private win: BaseWindow,
    private onViewCreated: (wc: Electron.WebContents) => void
  ) {}

  get isOpen(): boolean {
    return this.attached;
  }

  private ensure(): WebContentsView {
    if (this.view) return this.view;
    this.view = new WebContentsView({
      webPreferences: {
        preload: path.join(__dirname, '../preload/sidebar.cjs'),
        contextIsolation: true,
      },
    });
    this.view.setBackgroundColor('#00000000');
    loadRoute(this.view.webContents, 'find');
    this.onViewCreated(this.view.webContents);
    return this.view;
  }

  /** `paneBounds` is the focused pane, so the bar follows a split rather than the window. */
  open(target: Electron.WebContents, paneBounds: Rect, serviceId?: string): void {
    const view = this.ensure();
    this.target = target;
    this.targetService = serviceId ?? null;
    if (!this.attached) {
      this.win.contentView.addChildView(view);
      this.attached = true;
    }
    this.layout(paneBounds);
    view.webContents.focus();
    // `safeSend`: same reason as the overlay — ⌘F reaches here from the menu, where a throw is
    // invisible and reads as a dead shortcut.
    safeSend(view.webContents, 'find:opened');
  }

  layout(paneBounds: Rect): void {
    if (!this.view || !this.attached) return;
    this.view.setBounds({
      x: Math.max(0, paneBounds.x + paneBounds.width - WIDTH - MARGIN),
      y: paneBounds.y + MARGIN,
      width: WIDTH,
      height: HEIGHT,
    });
  }

  search(query: string, { forward = true, findNext = false } = {}): void {
    if (!this.target || this.target.isDestroyed()) return;
    if (!query) {
      // An empty query would throw; treat it as clearing the highlight instead.
      this.target.stopFindInPage('clearSelection');
      return;
    }
    this.target.findInPage(query, { forward, findNext });
  }

  /**
   * `keepSelection` leaves the last match selected, so closing the bar and starting to type or copy
   * behaves the way it does in a browser.
   */
  close(): void {
    if (this.target && !this.target.isDestroyed()) {
      this.target.stopFindInPage('keepSelection');
    }
    this.target = null;
    this.targetService = null;
    if (!this.attached || !this.view) return;
    // Removed, not hidden — an attached view keeps eating clicks in its rectangle.
    try {
      this.win.contentView.removeChildView(this.view);
    } catch {
      // `AppWindow.dispose()` runs on `closed`, so the window is already destroyed by the time it
      // calls this. Throwing here skipped the rest of teardown.
    }
    this.attached = false;
  }

  /**
   * Teardown. As with the overlay, `close()` only detaches and the view is cached for reuse, so a
   * closed find bar is a detached view holding a live renderer that the window's destruction does
   * not collect.
   */
  destroy(): void {
    this.close();
    if (!this.view) return;
    if (!this.view.webContents.isDestroyed()) this.view.webContents.close();
    this.view = null;
  }

  /** Re-added on top after any relayout, so a split doesn't bury it. */
  raise(paneBounds: Rect | null): void {
    if (!this.attached || !this.view || !paneBounds) return;
    this.win.contentView.removeChildView(this.view);
    this.win.contentView.addChildView(this.view);
    this.layout(paneBounds);
  }

  get targetServiceId(): string | null {
    return this.targetService;
  }

  get contents() {
    return this.view?.webContents ?? null;
  }
}

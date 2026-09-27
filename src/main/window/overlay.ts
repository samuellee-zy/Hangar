import path from 'node:path';
import { WebContentsView, type BaseWindow } from 'electron';
import { loadRoute } from '@main/platform/renderer-url';
import { safeSend } from '@main/platform/safe-send';
import type { OverlayMode } from '@shared/types';

/**
 * The ⌘K palette, layered above the panes.
 *
 * The one thing to get right: a transparent WebContentsView still hit-tests across its entire
 * bounds. Leaving it attached and merely hidden makes it swallow every click meant for the app
 * underneath — a bug that looks like the whole window freezing. So it is *removed* on close and
 * re-added on open, and it is always added last so it z-orders on top.
 */
export class Overlay {
  private view: WebContentsView | null = null;
  private attached = false;
  private mode: OverlayMode | null = null;
  /** Bumped on every open so the renderer can remount even when the mode is unchanged. */
  private nonce = 0;

  constructor(
    private win: BaseWindow,
    private onViewCreated: (wc: Electron.WebContents) => void
  ) {}

  get isOpen(): boolean {
    return this.attached;
  }

  /** Which surface is showing — the palette and the picker share one view and one lifecycle. */
  get currentMode(): OverlayMode | null {
    return this.mode;
  }

  get currentNonce(): number {
    return this.nonce;
  }

  get contents() {
    return this.view?.webContents ?? null;
  }

  private ensure(): WebContentsView {
    if (this.view) return this.view;
    this.view = new WebContentsView({
      webPreferences: {
        preload: path.join(__dirname, '../preload/sidebar.cjs'),
        contextIsolation: true,
        // Explicit rather than left to the default: these views hold the app's bridge (decisions #97).
        sandbox: true,
        transparent: true,
      },
    });
    this.view.setBackgroundColor('#00000000');

    loadRoute(this.view.webContents, 'overlay');
    // Escape reaches this view through `attachShortcuts`, which the owner wires up in
    // `onViewCreated` along with the rest of the keymap. That is a main-process
    // `before-input-event` handler, so it still works when the renderer hasn't mounted or has
    // thrown — which matters here more than anywhere else, since a transparent full-window view
    // hit-tests everywhere and a broken one leaves the whole app unclickable.
    //
    // It used to be a bespoke handler on this class. Two handlers on one contents meant Escape
    // dispatched `close-overlay` twice, and the palette was the one surface where ⌘K and ⌘,
    // did nothing at all.
    this.onViewCreated(this.view.webContents);
    return this.view;
  }

  open(mode: OverlayMode): void {
    const view = this.ensure();
    if (!this.attached) {
      this.win.contentView.addChildView(view); // last child == topmost
      this.layout();
      this.attached = true;
    }
    this.mode = mode;
    this.nonce++;
    view.webContents.focus();
    // Sent on every open, including a mode switch while already attached, so the renderer can
    // reset its own transient state (query text, selection) without remounting.
    //
    // `safeSend`, because a crashed overlay renderer throws on `send` — and this is reached from a
    // menu item and a global chord, where the exception surfaces nowhere and ⌘K looks dead.
    safeSend(view.webContents, 'overlay:mode', { mode, nonce: this.nonce });
  }

  close(): void {
    if (!this.attached || !this.view) return;
    this.win.contentView.removeChildView(this.view);
    this.attached = false;
    this.mode = null;
  }

  /**
   * Teardown. `close()` only detaches — deliberately, because the view is cached in `ensure()` and
   * reused on the next ⌘K — so a *closed* overlay is a detached view holding a live renderer.
   * Detached views are not children of the window and so aren't destroyed with it: the same leak
   * decisions #54 fixed for service views, which never covered this one.
   *
   * The window is already gone by the time dispose runs, so `removeChildView` is best-effort.
   */
  destroy(): void {
    if (!this.view) return;
    if (this.attached) {
      try {
        this.win.contentView.removeChildView(this.view);
      } catch {
        // The window is destroyed, which detached it for us. The close below is what matters.
      }
      this.attached = false;
    }
    if (!this.view.webContents.isDestroyed()) this.view.webContents.close();
    this.view = null;
    this.mode = null;
  }

  /** Full-bleed over everything including the rail, so the palette can dim the whole window. */
  layout(): void {
    if (!this.view) return;
    const { width, height } = this.win.getContentBounds();
    this.view.setBounds({ x: 0, y: 0, width, height });
  }

  /** Re-added on every open, so keep it topmost when panes change underneath. */
  raise(): void {
    if (!this.attached || !this.view) return;
    this.win.contentView.removeChildView(this.view);
    this.win.contentView.addChildView(this.view);
    this.layout();
  }
}

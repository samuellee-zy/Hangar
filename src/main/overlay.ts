import path from 'node:path';
import { WebContentsView, type BaseWindow } from 'electron';
import { loadRoute } from './renderer-url';
import type { OverlayMode } from '../shared/types';

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
    private onEscape: () => void,
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
        transparent: true,
      },
    });
    this.view.setBackgroundColor('#00000000');

    // Escape is handled in main, on the overlay's own contents, not in React. The overlay is a
    // transparent full-window view that hit-tests everywhere, so if the renderer hasn't mounted —
    // or has thrown — a React-only Escape handler leaves the whole app unclickable with no way
    // out. This is the escape hatch that works even when the surface above it is broken.
    this.view.webContents.on('before-input-event', (event, input) => {
      if (input.type === 'keyDown' && input.key === 'Escape') {
        event.preventDefault();
        this.onEscape();
      }
    });

    loadRoute(this.view.webContents, 'overlay');
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
    view.webContents.send('overlay:mode', { mode, nonce: this.nonce });
  }

  close(): void {
    if (!this.attached || !this.view) return;
    this.win.contentView.removeChildView(this.view);
    this.attached = false;
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

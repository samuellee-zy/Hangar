import path from 'node:path';
import { WebContentsView, type BaseWindow, type WebContents } from 'electron';
import { loadRoute } from '@main/platform/renderer-url';
import type { Rect } from '@shared/types';

/** Native content destination; detached on close, destroyed with its owner. */
export class ContentSurface {
  private view: WebContentsView | null = null;
  private attached = false;
  isOpen = false;
  constructor(private readonly win: BaseWindow, private readonly route: 'inbox' | 'ai', private readonly adopt: (wc: WebContents) => void) {}
  get contents(): WebContents | null { return this.view?.webContents ?? null; }
  open(): void {
    if (!this.view) {
      this.view = new WebContentsView({ webPreferences: { preload: path.join(__dirname, '../preload/sidebar.cjs'), contextIsolation: true, sandbox: true } });
      loadRoute(this.view.webContents, this.route);
      this.adopt(this.view.webContents);
    }
    this.isOpen = true;
    this.setVisible(true);
    this.view.webContents.focus();
  }
  place(rect: Rect): void { if (this.isOpen && this.view) this.view.setBounds(rect); }
  setVisible(visible: boolean): void {
    if (!this.view || visible === this.attached) return;
    if (visible && this.isOpen) { this.win.contentView.addChildView(this.view); this.attached = true; }
    else if (!visible) { this.win.contentView.removeChildView(this.view); this.attached = false; }
  }
  close(): void {
    if (!this.isOpen || !this.view) return;
    this.setVisible(false);
    this.isOpen = false;
    this.attached = false;
  }
  destroy(): void {
    if (this.view && !this.view.webContents.isDestroyed()) this.view.webContents.close();
    this.view = null;
    this.isOpen = false;
  }
}

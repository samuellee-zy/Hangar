import path from 'node:path';
import { WebContentsView, type BaseWindow, type WebContents } from 'electron';
import { loadRoute } from '@main/platform/renderer-url';
import type { Rect } from '@shared/types';

/** Native content destination; detached on close, destroyed with its owner. */
export class ContentSurface {
  private view: WebContentsView | null = null;
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
    this.win.contentView.addChildView(this.view);
    this.view.webContents.focus();
  }
  place(rect: Rect): void { if (this.isOpen && this.view) this.view.setBounds(rect); }
  close(): void {
    if (!this.isOpen || !this.view) return;
    this.win.contentView.removeChildView(this.view);
    this.isOpen = false;
  }
  destroy(): void {
    if (this.view && !this.view.webContents.isDestroyed()) this.view.webContents.close();
    this.view = null;
    this.isOpen = false;
  }
}

import path from 'node:path';
import { WebContentsView, type BaseWindow, type WebContents } from 'electron';
import { loadRoute } from '@main/platform/renderer-url';
import type { Rect } from '@shared/types';
import { IdleRelease } from './idle-release';

/** Native content destination; detached on close, destroyed with its owner. */
export class ContentSurface {
  private view: WebContentsView | null = null;
  private attached = false;
  isOpen = false;
  pending = 0;
  readonly state: Record<string, unknown> = {};
  private readonly idle = new IdleRelease(() => { void this.release(); });
  constructor(private readonly win: BaseWindow, private readonly route: 'inbox' | 'ai', private readonly adopt: (wc: WebContents) => void) {}
  get contents(): WebContents | null { return this.view?.webContents ?? null; }
  open(): void {
    this.idle.cancel();
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
    if (!this.view) return;
    this.view.setVisible(visible && this.isOpen);
    if (visible === this.attached) return;
    if (visible && this.isOpen) { this.win.contentView.addChildView(this.view); this.attached = true; }
    else if (!visible) { this.win.contentView.removeChildView(this.view); this.attached = false; }
  }
  close(): void {
    if (!this.isOpen || !this.view) return;
    this.setVisible(false);
    this.isOpen = false;
    this.attached = false;
    this.idle.arm();
  }
  private async release(): Promise<void> {
    if (this.isOpen) return;
    if (this.pending) { this.idle.arm(); return; }
    const view = this.view;
    const wc = view?.webContents;
    if (!wc || wc.isDestroyed()) { this.view = null; return; }
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let hasDraft = true;
    try {
      // Connection setup secrets stay in their renderer. Oversized UI values cannot fit the
      // bounded state store either, so keep that renderer until the draft is cleared.
      hasDraft = await Promise.race([
        wc.executeJavaScriptInIsolatedWorld(1107, [{ code: `[...document.querySelectorAll('input,textarea')].some((field) =>
          JSON.stringify(field.value).length > 16384 || field.tagName === 'INPUT' && !!field.closest('form') && !['checkbox','radio','submit'].includes(field.type) && !!field.value)` }]),
        new Promise<boolean>((resolve) => { timeout = setTimeout(() => resolve(true), 1_000); }),
      ]);
    } catch { /* Unknown draft state: retain it. */ }
    finally { clearTimeout(timeout); }
    if (this.isOpen || this.view !== view) return;
    if (this.pending || hasDraft) { this.idle.arm(); return; }
    if (!wc.isDestroyed()) wc.close();
    this.view = null;
  }
  destroy(): void {
    this.idle.cancel();
    if (this.view && !this.view.webContents.isDestroyed()) this.view.webContents.close();
    this.view = null;
    this.isOpen = false;
  }
}

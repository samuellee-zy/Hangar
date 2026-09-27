import path from 'node:path';
import { WebContentsView, type BaseWindow, type WebContents } from 'electron';
import { loadRoute } from '@main/platform/renderer-url';
import { safeSend } from '@main/platform/safe-send';
import type { PaneBar, PaneChromeState, Rect } from '@shared/types';

/**
 * The bars that speak for a pane: the title bar across the top strip, where there is one, and —
 * with `appearance.paneHeaders` on — a header above each pane.
 *
 * Each is a small renderer of its own, the way the splitters are: a pane's page is a separate
 * `webContents`, and nothing of ours can be drawn inside it. They decide nothing. Main sends each
 * one what to show (`PaneChromeState`), only when that changes, and they send back the same
 * commands the menus do.
 *
 * Headers are pooled like the splitters, so opening and closing a pane doesn't start and stop a
 * renderer each time.
 */
export class PaneChrome {
  private titlebar: WebContentsView | null = null;
  private titlebarAttached = false;
  private headers: WebContentsView[] = [];
  private headerPanes: string[] = [];
  private attachedHeaders = 0;
  /** What each view is showing now, for a view that asks on load and for the change check. */
  private states = new Map<WebContents, PaneChromeState>();
  private sent = new Map<WebContents, string>();

  constructor(
    private readonly win: BaseWindow,
    /** Shortcuts, so a chord still works while one of these has focus from a click. */
    private readonly onViewCreated: (wc: WebContents) => void,
  ) {}

  /** The strip across the top of the window, or null when the rail holds the traffic lights. */
  placeTitlebar(rect: Rect | null): void {
    if (!rect) {
      if (this.titlebar && this.titlebarAttached) this.win.contentView.removeChildView(this.titlebar);
      this.titlebarAttached = false;
      return;
    }
    this.titlebar ??= this.create('titlebar');
    if (!this.titlebarAttached) {
      this.win.contentView.addChildView(this.titlebar);
      this.titlebarAttached = true;
    }
    this.titlebar.setBounds(rect);
  }

  /**
   * One header per pane that has one, in pane order.
   *
   * Every attached header is re-added, which moves it to the top — so the caller does this
   * *before* re-adding the panes, and each page ends up above the part of its header tucked under
   * it (`splitCard`).
   */
  placeHeaders(headers: ReadonlyArray<{ paneId: string; rect: Rect }>, { reorder = true } = {}): void {
    while (this.attachedHeaders > headers.length) {
      this.attachedHeaders--;
      this.win.contentView.removeChildView(this.headers[this.attachedHeaders]!);
    }
    headers.forEach(({ paneId, rect }, i) => {
      const view = this.headers[i] ?? (this.headers[i] = this.create(`header-${i}`));
      if (i >= this.attachedHeaders || reorder) this.win.contentView.addChildView(view);
      view.setBounds(rect);
      this.headerPanes[i] = paneId;
    });
    this.attachedHeaders = headers.length;
    this.headerPanes.length = headers.length;
  }

  /** What every bar shows: the title bar speaks for `focused`, each header for its own pane. */
  update(bars: readonly PaneBar[], focused: PaneBar | null, inset: number): void {
    if (this.titlebar) this.show(this.titlebar.webContents, { kind: 'titlebar', bar: focused, inset });
    const byPane = new Map(bars.map((bar) => [bar.paneId, bar]));
    this.headers.slice(0, this.attachedHeaders).forEach((view, i) => {
      this.show(view.webContents, { kind: 'header', bar: byPane.get(this.headerPanes[i]!) ?? null, inset: 0 });
    });
  }

  /** For a bar that has just loaded and asks what to show. */
  stateFor(wc: WebContents): PaneChromeState | null {
    return this.states.get(wc) ?? null;
  }

  private show(wc: WebContents, state: PaneChromeState): void {
    this.states.set(wc, state);
    const signature = JSON.stringify(state);
    if (this.sent.get(wc) === signature) return;
    this.sent.set(wc, signature);
    safeSend(wc, 'pane-chrome:state', state);
  }

  private create(route: 'titlebar' | `header-${number}`): WebContentsView {
    const view = new WebContentsView({
      webPreferences: {
        preload: path.join(__dirname, '../preload/sidebar.cjs'),
        contextIsolation: true,
        // Explicit rather than left to the default: these views hold the app's bridge (decisions #97).
        sandbox: true,
      },
    });
    // Until its stylesheet paints: the window's own colour shows through, not a white bar.
    view.setBackgroundColor('#00000000');
    loadRoute(view.webContents, route);
    this.onViewCreated(view.webContents);
    // A reload — the crash recovery `loadRoute` installs — starts with nothing sent.
    view.webContents.on('did-start-loading', () => this.sent.delete(view.webContents));
    return view;
  }

  destroy(): void {
    this.placeTitlebar(null);
    this.placeHeaders([]);
    for (const view of [this.titlebar, ...this.headers]) {
      if (view && !view.webContents.isDestroyed()) view.webContents.close();
    }
    this.titlebar = null;
    this.headers = [];
    this.states.clear();
    this.sent.clear();
  }
}

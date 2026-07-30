import path from 'node:path';
import { WebContentsView } from 'electron';
import { resolveUrl } from '@shared/catalog';
import { captureFavicon } from '@main/features/icons';
import { decideFailure, errorPageHtml, shouldRecoverFromCrash } from '@core/runtime/recovery';
import { attachNavigationGuards, partitionFor, sessionFor } from '@main/platform/session';
import { attachShortcuts, type CommandSink } from '@main/window/shortcuts';
import type { ServiceInstance } from '@shared/types';

/**
 * Owns the WebContentsView per service instance. Views outlive panes: switching a pane to another
 * service detaches the old view rather than destroying it, so going back is instant. Destruction
 * is reserved for hibernation (Phase 6) and for services removed from config.
 */

export interface ServiceRuntime {
  view: WebContentsView;
  loading: boolean;
  unread: number;
  /** Consecutive automatic recovery attempts. Reset by any successful load. */
  failures: number;
  /** Epoch ms of the last time this service was on screen. Drives hibernation. */
  lastActiveAt: number;
}

const preloadPath = () => path.join(__dirname, '../preload/service.cjs');

export class ServiceManager {
  private runtimes = new Map<string, ServiceRuntime>();

  constructor(
    private onChange: () => void,
    private onCommand: CommandSink,
    /** Lets the window attach the web context menu without ServiceManager knowing about menus. */
    private onViewCreated: (wc: Electron.WebContents) => void,
    /** Search results are reported by the searched contents, but rendered by the find bar. */
    private onFoundInPage: (active: number, total: number) => void
  ) {}

  get(serviceId: string): ServiceRuntime | undefined {
    return this.runtimes.get(serviceId);
  }

  has(serviceId: string): boolean {
    return this.runtimes.has(serviceId);
  }

  ensure(svc: ServiceInstance): ServiceRuntime {
    const existing = this.runtimes.get(svc.id);
    if (existing) return existing;

    const partition = partitionFor(svc);
    const ses = sessionFor(svc);

    const view = new WebContentsView({
      webPreferences: {
        partition,
        preload: preloadPath(),
        contextIsolation: true,
        // Sandboxed: the preload only needs contextBridge and ipcRenderer, both available under
        // sandbox. Verified against the notification path, which is the most demanding consumer.
        sandbox: true,
        // Services are third-party web apps; keep them out of our process.
        nodeIntegration: false,
        // Off so a backgrounded pane in a split view keeps rendering and delivering.
        backgroundThrottling: false,
        // Required for dictionarySuggestions to be populated in the context-menu event. Setting
        // spellchecker languages alone (session.ts) does nothing without it.
        spellcheck: true,
      },
    });

    const runtime: ServiceRuntime = {
      view,
      loading: true,
      unread: 0,
      failures: 0,
      lastActiveAt: Date.now(),
    };
    this.runtimes.set(svc.id, runtime);

    attachNavigationGuards(view.webContents, svc, partition);
    // Bound here, once per view, rather than on the focus path — see attachShortcuts.
    attachShortcuts(view.webContents, this.onCommand);
    // No-op for services with a vendored logo; only custom connections need this.
    captureFavicon(view.webContents, svc, ses);
    this.onViewCreated(view.webContents);

    view.webContents.on('did-start-loading', () => {
      runtime.loading = true;
      this.onChange();
    });
    view.webContents.on('did-stop-loading', () => {
      runtime.loading = false;
      this.onChange();
    });

    // A load that actually succeeded clears the backoff, so an outage earlier in the session
    // doesn't make the next unrelated blip give up immediately.
    view.webContents.on('found-in-page', (_e, result) => {
      this.onFoundInPage(result.activeMatchOrdinal, result.matches);
    });

    view.webContents.on('did-finish-load', () => {
      runtime.failures = 0;
    });

    view.webContents.on('did-fail-load', (_e, errorCode, errorDescription, url, isMainFrame) => {
      const action = decideFailure({ errorCode, isMainFrame, attempts: runtime.failures });
      if (!action.showError && action.retryAfterMs === null) return; // aborted, or a subframe

      runtime.failures++;
      if (action.retryAfterMs !== null) {
        setTimeout(() => {
          if (!view.webContents.isDestroyed()) view.webContents.reload();
        }, action.retryAfterMs);
        return;
      }

      void view.webContents.loadURL(
        errorPageHtml({
          serviceName: svc.name,
          url: url || resolveUrl(svc),
          errorCode,
          description: errorDescription,
          // -106 INTERNET_DISCONNECTED deserves different words from a site being down.
          offline: errorCode === -106,
        })
      );
    });

    view.webContents.on('render-process-gone', (_e, details) => {
      if (!shouldRecoverFromCrash(runtime.failures, details.reason)) return;
      runtime.failures++;
      console.warn(`[crash] ${svc.name}: ${details.reason} — reloading`);
      if (!view.webContents.isDestroyed()) view.webContents.reload();
    });
    // Applied on every dom-ready, not just the first: an SPA navigation drops injected styles.
    view.webContents.on('dom-ready', () => {
      if (svc.customCss) void view.webContents.insertCSS(svc.customCss);
      if (svc.customJs) {
        view.webContents
          .executeJavaScript(svc.customJs, true)
          // User-authored script; a syntax error must not take the service down with it.
          .catch((err) => console.error(`[custom-js] ${svc.name}:`, err?.message ?? err));
      }
    });

    view.webContents.setZoomFactor(svc.zoom);
    void view.webContents.loadURL(resolveUrl(svc));

    return runtime;
  }

  /** Called for every visible service on each relayout, so idle time is "time off screen". */
  markActive(serviceId: string): void {
    const runtime = this.runtimes.get(serviceId);
    if (runtime) runtime.lastActiveAt = Date.now();
  }

  navigate(serviceId: string, direction: 'back' | 'forward'): void {
    const wc = this.runtimes.get(serviceId)?.view.webContents;
    if (!wc) return;
    const nav = wc.navigationHistory;
    if (direction === 'back' && nav.canGoBack()) nav.goBack();
    if (direction === 'forward' && nav.canGoForward()) nav.goForward();
  }

  destroy(serviceId: string): void {
    const runtime = this.runtimes.get(serviceId);
    if (!runtime) return;
    this.runtimes.delete(serviceId);
    if (!runtime.view.webContents.isDestroyed()) runtime.view.webContents.close();
  }

  all(): Map<string, ServiceRuntime> {
    return this.runtimes;
  }
}

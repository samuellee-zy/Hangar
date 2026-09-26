import path from 'node:path';
import { nativeTheme, WebContentsView } from 'electron';
import { isOrphaned, resolveUrl } from '@shared/catalog';
import { loadConfig } from '@main/platform/config';
import { captureFavicon } from '@main/features/icons';
import { creditSuspendedTime } from '@core/runtime/hibernate';
import {
  decideFailure,
  errorPageHtml,
  orphanPageHtml,
  shouldRecoverFromCrash,
} from '@core/runtime/recovery';
import { attachNavigationGuards, partitionFor, sessionFor } from '@main/platform/session';
import { attachShortcuts, type CommandSink } from '@main/window/shortcuts';
import type { KeyContext } from '@core/keyboard/keymap';
import type { ServiceInstance } from '@shared/types';

/**
 * Owns the WebContentsView per service instance. Views outlive panes: switching a pane to another
 * service detaches the old view rather than destroying it, so going back is instant. Destruction
 * is reserved for hibernation (Phase 6) and for services removed from config.
 */

export interface ServiceRuntime {
  view: WebContentsView;
  loading: boolean;
  /** Consecutive automatic recovery attempts. Reset by any successful load. */
  failures: number;
  /** Epoch ms of the last time this service was on screen. Drives hibernation. */
  lastActiveAt: number;
}

const preloadPath = () => path.join(__dirname, '../preload/service.cjs');

/**
 * Where a service's view should start.
 *
 * Normally the service. When its catalog entry has gone, an explanation instead of the
 * `about:blank` `resolveUrl` otherwise falls back to — that pane can never load anything, since
 * with no allowlist to check `isAllowedHost` refuses every navigation, so a blank page is a dead
 * end the user has no way to read. Shared with the retry path so both agree.
 */
export const startPageFor = (svc: ServiceInstance): string =>
  isOrphaned(svc)
    ? orphanPageHtml({ serviceName: svc.name, catalogId: svc.catalogId })
    : resolveUrl(svc);

export class ServiceManager {
  private runtimes = new Map<string, ServiceRuntime>();

  constructor(
    private onChange: () => void,
    private onCommand: CommandSink,
    /**
     * The keymap in force for one service — the shared bindings, minus the chords that service
     * keeps for itself. Resolved per keystroke by the window, which owns the config; a value
     * captured here would go stale the moment a binding or a passthrough list changed.
     */
    private keyContext: (serviceId: string) => KeyContext,
    /** Lets the window attach the web context menu without ServiceManager knowing about menus. */
    private onViewCreated: (wc: Electron.WebContents) => void,
    /** Search results are reported by the searched contents, but rendered by the find bar. */
    private onFoundInPage: (active: number, total: number) => void,
    /** A service's own title is the most reliable unread signal it gives us. See notify/unread.ts. */
    private onTitle: (serviceId: string, title: string) => void = () => {}
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
        // Offers "prevent this page from creating more dialogs" after a few, so a page looping
        // `alert()` can't hold a modal over the pane until the app is killed.
        safeDialogs: true,
      },
    });

    // Waking a hibernated service rebuilds the view from nothing, and Chromium paints an unstyled
    // view white — a full-pane white flash on every wake, including in dark mode. Matching the
    // app's own background makes the gap read as "loading" rather than as something breaking.
    view.setBackgroundColor(nativeTheme.shouldUseDarkColors ? '#1b1b1f' : '#f4f4f6');

    const runtime: ServiceRuntime = {
      view,
      loading: true,
      failures: 0,
      lastActiveAt: Date.now(),
    };
    this.runtimes.set(svc.id, runtime);

    attachNavigationGuards(view.webContents, svc, partition);
    // Bound here, once per view, rather than on the focus path — see attachShortcuts.
    attachShortcuts(view.webContents, this.onCommand, () => this.keyContext(svc.id));
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

    view.webContents.on('found-in-page', (_e, result) => {
      this.onFoundInPage(result.activeMatchOrdinal, result.matches);
    });

    // Fires on every SPA title change, not just navigation — which is exactly what a chat app does
    // when a message arrives.
    view.webContents.on('page-title-updated', (_e, title) => this.onTitle(svc.id, title));

    // One handler, because there was briefly a second one further down doing the zoom half. Both
    // ran, so the effect was right and the cost was a duplicated listener per view; the
    // `page-title-updated` beside it was duplicated the same way and was pure waste.
    view.webContents.on('did-finish-load', () => {
      // A load that actually succeeded clears the backoff, so an outage earlier in the session
      // doesn't make the next unrelated blip give up immediately.
      runtime.failures = 0;

      // Applied on every load, not once before the first navigation. Chromium's zoom level is
      // per-origin and resets on a cross-origin navigation, so a factor set on the empty
      // about:blank contents never survived to the real page — which read as "zoom resets itself"
      // after every reload and every wake from hibernation.
      //
      // Re-read from config rather than closing over `svc`: the instance captured when the view was
      // created is stale after a zoom change.
      const current = loadConfig().services.find((entry) => entry.id === svc.id);
      if (current) view.webContents.setZoomFactor(current.zoom);
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

    void view.webContents.loadURL(startPageFor(svc));

    return runtime;
  }

  /** Called for every visible service on each relayout, so idle time is "time off screen". */
  markActive(serviceId: string): void {
    const runtime = this.runtimes.get(serviceId);
    if (runtime) runtime.lastActiveAt = Date.now();
  }

  /** Time off screen shouldn't include time the machine was asleep. See `creditSuspendedTime`. */
  creditSuspendedTime(suspendedForMs: number): void {
    if (suspendedForMs <= 0) return;
    const now = Date.now();
    for (const runtime of this.runtimes.values()) {
      runtime.lastActiveAt = creditSuspendedTime(runtime.lastActiveAt, suspendedForMs, now);
    }
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

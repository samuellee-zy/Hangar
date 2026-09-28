import path from 'node:path';
import type { IpcMainEvent, IpcMainInvokeEvent, WebContents } from 'electron';
import { createRateLimiter, isAppRendererUrl, redactUrl } from '@core/runtime/urls';
import { openExternalSafely } from '@main/platform/external';

// The rail and the overlay are two routes of the same React bundle, selected by hash.
// electron-vite sets ELECTRON_RENDERER_URL in dev; in production we load the built file.

type Route =
  | 'rail'
  | 'overlay'
  | 'settings'
  | 'empty'
  | 'find'
  | 'drag'
  | 'titlebar'
  | `splitter-${number}`
  | `splitter-row-${number}`
  | `header-${number}`;

const rendererIndex = () => path.join(__dirname, '../renderer/index.html');

const appRenderer = () => ({
  devUrl: process.env['ELECTRON_RENDERER_URL'],
  indexFile: rendererIndex(),
});

/** Whether a URL is one of the app's own screens. See `isAppRendererUrl` for why this matters. */
export const isAppUrl = (url: string): boolean => isAppRendererUrl(url, appRenderer());

/**
 * Whether an IPC message comes from one of the app's own screens, rather than from a service page
 * or from anything one of those screens was navigated to.
 *
 * The frame, not the webContents: a webContents is a container, and what matters is the document
 * inside it at the moment it sent. A frame that has gone away (`null`) is refused.
 */
export function isInternalSender(event: IpcMainEvent | IpcMainInvokeEvent): boolean {
  const frame = event.senderFrame;
  return frame !== null && frame !== undefined && isAppUrl(frame.url);
}

/**
 * Renderer consoles are invisible from the terminal, so a React error in the rail or overlay just
 * looks like "the UI does nothing". Forwarding them to the main log makes those failures findable
 * without opening DevTools on a transparent, click-through view.
 */
export function forwardConsole(wc: WebContents, label: string): void {
  wc.on('console-message', (event) => {
    if (event.level === 'error' || event.level === 'warning') {
      console.log(`[${label}] ${event.level}: ${event.message} (${event.sourceId}:${event.lineNumber})`);
    }
  });
}

/**
 * An internal screen may show this renderer and nothing else.
 *
 * They hold `window.hangar`, which can send any command there is. Service views have navigation
 * guards; these had none, so dragging a link onto the rail navigated the rail to that page — with
 * the bridge still in it — and a `target="_blank"` would have opened a window that inherited the
 * preload. Links meant for a browser go to the browser; nothing else goes anywhere.
 */
function lockDown(wc: WebContents, route: Route): void {
  const refuse = (event: Electron.Event, url: string, via: string) => {
    if (isAppUrl(url)) return;
    event.preventDefault();
    console.warn(`[surface] ${route}: refused ${via} to ${redactUrl(url)}`);
  };
  wc.on('will-navigate', (event, url) => refuse(event, url, 'navigation'));
  wc.on('will-redirect', (event, url) => refuse(event, url, 'redirect'));
  wc.setWindowOpenHandler(({ url }) => {
    openExternalSafely(url, `the ${route} view`);
    return { action: 'deny' };
  });
  wc.on('will-attach-webview', (event) => event.preventDefault());
}

/** Three reloads a minute per screen: enough to survive a crash, not enough to spin in a loop. */
const mayRecover = createRateLimiter({ max: 3, windowMs: 60_000 });

/**
 * A crashed internal screen comes back by itself.
 *
 * Service views always recovered from a renderer crash; these never did. A dead rail renderer was a
 * permanently blank strip down the side of the window with every service still running behind it,
 * and nothing short of quitting brought it back.
 */
function recoverFromCrashes(wc: WebContents, route: Route): void {
  wc.on('render-process-gone', (_event, details) => {
    if (details.reason === 'clean-exit') return;
    if (!mayRecover(route)) {
      console.error(`[surface] ${route}: renderer ${details.reason} again — not reloading`);
      return;
    }
    console.warn(`[surface] ${route}: renderer ${details.reason} (exit ${details.exitCode}) — reloading`);
    if (!wc.isDestroyed()) show(wc, route);
  });
}

function show(wc: WebContents, route: Route): void {
  const devUrl = process.env['ELECTRON_RENDERER_URL'];
  const loaded = devUrl ? wc.loadURL(`${devUrl}#${route}`) : wc.loadFile(rendererIndex(), { hash: route });
  loaded.catch((err: unknown) => console.error(`[surface] ${route}: failed to load — ${String(err)}`));
}

export function loadRoute(wc: WebContents, route: Route): void {
  forwardConsole(wc, route);
  lockDown(wc, route);
  recoverFromCrashes(wc, route);
  show(wc, route);
}

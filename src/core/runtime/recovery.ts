/**
 * What to do when a service view fails. Pure, so the policy is testable without a network.
 *
 * Two traps sit in `did-fail-load` and both produce the same symptom — an error page over a page
 * that was fine:
 *
 *   1. **`ERR_ABORTED` (-3) is not a failure.** It fires whenever a navigation is superseded — a
 *      redirect, a user clicking through before load finishes, an SPA replacing a pending request.
 *      Treating it as an error means Gmail flashes an error page during ordinary use.
 *   2. **Subframe failures are not page failures.** An ad iframe or a third-party widget failing is
 *      routine; the page around it is fine. Only `isMainFrame` counts.
 */

import { THEME } from '@shared/theme';

/** Codes worth retrying on their own — transient network conditions rather than bad requests. */
const TRANSIENT = new Set([
  -2, // FAILED
  -21, // NETWORK_CHANGED
  -100, // CONNECTION_CLOSED
  -101, // CONNECTION_RESET
  -102, // CONNECTION_REFUSED
  -104, // CONNECTION_FAILED
  -105, // NAME_NOT_RESOLVED
  -109, // ADDRESS_UNREACHABLE
  -118, // CONNECTION_TIMED_OUT
]);

export const MAX_AUTO_RETRIES = 3;

/** ERR_INTERNET_DISCONNECTED: the machine itself has no network, as opposed to a site being down. */
export const OFFLINE = -106;

/**
 * How long a load has to stay up before it counts as recovery.
 *
 * Reset on `did-finish-load` alone, the backoff never advanced: Chromium commits an error page for
 * a failed navigation and that fires `did-finish-load` too, so every failure was followed by a
 * "success" that zeroed the count. Offline, a pane reloaded every second for as long as the network
 * was gone — 627 consecutive times on one sign-in URL, 96% of a 1 MB log. A page that stays loaded
 * for thirty seconds without failing is a real recovery; one that fails again sooner is the same
 * outage.
 */
export const HEALTHY_AFTER_MS = 30_000;

export interface FailureHistory {
  /** Automatic attempts spent so far. */
  failures: number;
  /** Epoch ms of the last failed main-frame load, or null. */
  lastFailureAt: number | null;
  /** Epoch ms of the last finished load, or null. Includes Chromium's own error pages. */
  lastLoadedAt: number | null;
}

/** The attempts to count against a failure happening at `now` — zero only after a real recovery. */
export function attemptsSoFar(history: FailureHistory, now: number): number {
  const { failures, lastFailureAt, lastLoadedAt } = history;
  const recovered =
    lastLoadedAt !== null &&
    (lastFailureAt === null || lastLoadedAt > lastFailureAt) &&
    now - lastLoadedAt >= HEALTHY_AFTER_MS;
  return recovered ? 0 : failures;
}

export interface FailureContext {
  errorCode: number;
  isMainFrame: boolean;
  /** How many automatic retries have already been spent on this service. */
  attempts: number;
}

export interface FailureAction {
  /** Replace the pane with the error page. */
  showError: boolean;
  /** Retry after this many ms, or null to leave it to the user. */
  retryAfterMs: number | null;
  /**
   * Reload by itself once the machine is back online. Only for OFFLINE: retrying on a timer while
   * the OS reports no network is guaranteed to fail, and waiting for the user to notice the
   * network came back is a pane that stays broken for no reason.
   */
  waitForNetwork?: true;
}

export function decideFailure(ctx: FailureContext): FailureAction {
  // Aborted navigations and subframe errors are noise — do nothing at all.
  if (ctx.errorCode === -3 || !ctx.isMainFrame) {
    return { showError: false, retryAfterMs: null };
  }

  if (ctx.errorCode === OFFLINE) {
    return { showError: true, retryAfterMs: null, waitForNetwork: true };
  }

  if (TRANSIENT.has(ctx.errorCode) && ctx.attempts < MAX_AUTO_RETRIES) {
    // Backing off rather than hammering: 1s, 2s, 4s. A dropped VPN usually recovers inside that.
    return { showError: false, retryAfterMs: 1000 * 2 ** ctx.attempts };
  }

  return { showError: true, retryAfterMs: null };
}

/** A crashed renderer is always worth one automatic reload; a crash loop is not. */
export function shouldRecoverFromCrash(attempts: number, reason: string): boolean {
  // `clean-exit` means we closed it ourselves — hibernation, pane close, quit.
  if (reason === 'clean-exit') return false;
  return attempts < MAX_AUTO_RETRIES;
}

const escape = (text: string) =>
  text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/**
 * The frame every in-pane page shares: one card, centred, in the app's own colours for either theme
 * (`shared/theme.ts`). Three copies of this had drifted apart in their widths and button spacing.
 */
function page(card: string): string {
  const { dark, light } = THEME;
  return `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html>
<meta charset="utf-8">
<style>
  :root { color-scheme: dark light; }
  body {
    margin: 0; height: 100vh; display: grid; place-items: center;
    font: 14px/1.6 -apple-system, BlinkMacSystemFont, sans-serif;
    background: ${dark.bg}; color: ${dark.fg};
  }
  @media (prefers-color-scheme: light) { body { background: ${light.bg}; color: ${light.fg}; } }
  .card { max-width: 400px; text-align: center; padding: 0 24px; }
  h1 { font-size: 17px; font-weight: 500; margin: 0 0 8px; }
  p { margin: 0 0 6px; opacity: .7; }
  code { font: 11px ui-monospace, Menlo, monospace; opacity: .5; word-break: break-all; }
  .actions { margin-top: 18px; display: flex; gap: 8px; justify-content: center; }
  button {
    padding: 8px 18px; font: inherit; font-size: 13px; cursor: pointer;
    border: 1px solid currentColor; border-radius: 8px; background: none; color: inherit;
    opacity: .85;
  }
  button:hover { opacity: 1; }
</style>
<div class="card">${card}
</div>`)}`;
}

/**
 * The in-pane error page. Served as a data URL into the failed view, so it inherits the service's
 * preload and can call `__hangar.retry()` — no extra window, no extra route.
 */
export function errorPageHtml(opts: {
  serviceName: string;
  url: string;
  errorCode: number;
  description: string;
  offline: boolean;
}): string {
  const headline = opts.offline ? "You're offline" : `${escape(opts.serviceName)} didn't load`;
  // In words, with Chromium's own name for it in the small print. The page used to say only
  // "ERR_NAME_NOT_RESOLVED (-105)", which is a search term, not an explanation.
  const detail = opts.offline
    ? 'Reconnecting by itself as soon as the network is back.'
    : escape(explainLoadError(opts.errorCode, hostOf(opts.url)));
  const code = opts.offline ? escape(opts.url) : `${escape(opts.description || 'failed')} (${opts.errorCode}) · ${escape(opts.url)}`;

  return page(`
  <h1>${headline}</h1>
  <p>${detail}</p>
  <code>${code}</code>
  <div class="actions">
    <button onclick="window.__hangar && window.__hangar.retry()">${opts.offline ? 'Try now' : 'Try again'}</button>
    ${opts.offline ? '' : '<button onclick="window.__hangar && window.__hangar.openInBrowser()">Open in browser</button>'}
  </div>`);
}

const hostOf = (url: string): string => {
  try {
    return new URL(url).hostname || url;
  } catch {
    return url;
  }
};

/**
 * What a failed load means, for the ones people actually meet. Chromium's net error codes — the
 * certificate ones are the -200 range.
 */
export function explainLoadError(code: number, host: string): string {
  switch (code) {
    case -105: // NAME_NOT_RESOLVED
    case -137: // NAME_RESOLUTION_FAILED
      return `Couldn't find ${host}. Check the address, or whether this Mac can reach it.`;
    case -102: // CONNECTION_REFUSED
      return `${host} refused the connection. It may be down, or not serving on this address.`;
    case -7: // TIMED_OUT
    case -118: // CONNECTION_TIMED_OUT
      return `${host} took too long to answer.`;
    case -101: // CONNECTION_RESET
    case -100: // CONNECTION_CLOSED
      return 'The connection was cut off partway. Trying again usually works.';
    case -21: // NETWORK_CHANGED
      return 'The network changed while the page was loading.';
    case -130: // PROXY_CONNECTION_FAILED
    case -111: // TUNNEL_CONNECTION_FAILED
      return "Couldn't get through the proxy. Check it under Settings → Network.";
    case -109: // ADDRESS_UNREACHABLE
      return `${host} can't be reached from this network — a VPN it needs may be off.`;
  }
  if (code <= -200 && code > -300) {
    return `${host}'s security certificate isn't trusted, so Hangar won't load it.`;
  }
  return 'The page failed to load.';
}

/**
 * Shown when a service's page keeps crashing and the automatic reloads have run out. It used to be
 * nothing at all: after the third crash the handler returned and the pane stayed dead, with no
 * page, no message and no way back short of sleeping and waking the service.
 */
export function crashedPageHtml(opts: { serviceName: string; reason: string }): string {
  return page(`
  <h1>${escape(opts.serviceName)} keeps crashing</h1>
  <p>Its page stopped ${MAX_AUTO_RETRIES} times, so Hangar has stopped reloading it by itself.</p>
  <code>${escape(opts.reason)}</code>
  <div class="actions"><button onclick="window.__hangar && window.__hangar.retry()">Reload ${escape(opts.serviceName)}</button></div>`);
}

/**
 * Shown when a service's catalog entry has vanished — see `isOrphaned`. There is no in-pane fix
 * (the service needs a URL, or removing), so the button goes to where both are: its settings page.
 * Not a Remove button: this preload is in every page of the service, and nothing a page can call
 * should be destructive.
 */
export function orphanPageHtml(opts: { serviceName: string; catalogId: string }): string {
  return page(`
  <h1>${escape(opts.serviceName)} is no longer in the catalog</h1>
  <p>Hangar doesn't know what to load for it, so this pane has nothing to show.</p>
  <p>Give it a start page of its own, or remove it — both are on its settings page.</p>
  <code>${escape(opts.catalogId)}</code>
  <div class="actions"><button onclick="window.__hangar && window.__hangar.openSettings()">Open its settings</button></div>`);
}

/**
 * Whether a blocked navigation should replace what the pane is showing.
 *
 * The common block by far is an ordinary external link — clicking a link in Gmail opens the
 * browser and correctly leaves Gmail untouched. Replacing the pane every time would break that
 * case in the name of the rare one, so a blocked page is only worth showing when the pane holds
 * nothing: never committed a page, `about:blank`, or one of our own data-URL pages.
 *
 * The `data:` case matters for `will-redirect`, where `preventDefault()` cancels the whole
 * navigation and can leave the pane dead — including on a blocked page it already showed.
 */
export function shouldShowBlockedPage(currentUrl: string): boolean {
  return currentUrl === '' || currentUrl === 'about:blank' || currentUrl.startsWith('data:');
}

/**
 * Shown in-pane when a navigation was refused for leaving the service's allowlist and there was
 * no live page to keep. Same data-URL trick as `errorPageHtml`, for the same reason: it inherits
 * the service preload, so its buttons can call back through `__hangar`.
 *
 * `allowHost()` deliberately takes no argument. The preload is in every service page, so a host
 * passed from the page would let any service widen its own allowlist; main instead applies the
 * host it just blocked for that service.
 */
export function blockedPageHtml(opts: { serviceName: string; url: string; host: string }): string {
  return page(`
  <h1>${escape(opts.serviceName)} tried to leave</h1>
  <p><strong>${escape(opts.host)}</strong> isn't on this service's allowed list, so Hangar opened it in your browser instead.</p>
  <p>If it's part of signing in, allow it and try again.</p>
  <code>${escape(opts.url)}</code>
  <div class="actions">
    <button onclick="window.__hangar && window.__hangar.allowHost()">Allow ${escape(opts.host)}</button>
    <button onclick="window.__hangar && window.__hangar.retry()">Back to ${escape(opts.serviceName)}</button>
  </div>`);
}

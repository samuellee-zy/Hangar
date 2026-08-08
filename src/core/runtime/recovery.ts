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

/** Codes worth retrying on their own — transient network conditions rather than bad requests. */
const TRANSIENT = new Set([
  -2, // FAILED
  -21, // NETWORK_CHANGED
  -100, // CONNECTION_CLOSED
  -101, // CONNECTION_RESET
  -102, // CONNECTION_REFUSED
  -104, // CONNECTION_FAILED
  -105, // NAME_NOT_RESOLVED
  -106, // INTERNET_DISCONNECTED
  -109, // ADDRESS_UNREACHABLE
  -118, // CONNECTION_TIMED_OUT
]);

export const MAX_AUTO_RETRIES = 3;

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
}

export function decideFailure(ctx: FailureContext): FailureAction {
  // Aborted navigations and subframe errors are noise — do nothing at all.
  if (ctx.errorCode === -3 || !ctx.isMainFrame) {
    return { showError: false, retryAfterMs: null };
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
  const detail = opts.offline
    ? 'Hangar will keep the page ready. Reconnect and try again.'
    : `${escape(opts.description || 'The page failed to load')} (${opts.errorCode})`;

  return `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html>
<meta charset="utf-8">
<style>
  :root { color-scheme: dark light; }
  body {
    margin: 0; height: 100vh; display: grid; place-items: center;
    font: 14px/1.6 -apple-system, BlinkMacSystemFont, sans-serif;
    background: #1b1b1f; color: #e8e8ea;
  }
  @media (prefers-color-scheme: light) { body { background: #f4f4f6; color: #1b1b1f; } }
  .card { max-width: 380px; text-align: center; padding: 0 24px; }
  h1 { font-size: 17px; font-weight: 500; margin: 0 0 8px; }
  p { margin: 0 0 6px; opacity: .7; }
  code { font: 11px ui-monospace, Menlo, monospace; opacity: .5; word-break: break-all; }
  button {
    margin-top: 18px; padding: 8px 18px; font: inherit; font-size: 13px; cursor: pointer;
    border: 1px solid currentColor; border-radius: 8px; background: none; color: inherit;
    opacity: .85;
  }
  button:hover { opacity: 1; }
</style>
<div class="card">
  <h1>${headline}</h1>
  <p>${detail}</p>
  <code>${escape(opts.url)}</code>
  <div><button onclick="window.__hangar && window.__hangar.retry()">Try again</button></div>
</div>`)}`;
}

/**
 * Shown when a service's catalog entry has vanished — see `isOrphaned`. There is no in-pane fix
 * (the service needs a URL, or removing), so this offers words rather than a button.
 */
export function orphanPageHtml(opts: { serviceName: string; catalogId: string }): string {
  return `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html>
<meta charset="utf-8">
<style>
  :root { color-scheme: dark light; }
  body {
    margin: 0; height: 100vh; display: grid; place-items: center;
    font: 14px/1.6 -apple-system, BlinkMacSystemFont, sans-serif;
    background: #1b1b1f; color: #e8e8ea;
  }
  @media (prefers-color-scheme: light) { body { background: #f4f4f6; color: #1b1b1f; } }
  .card { max-width: 380px; text-align: center; padding: 0 24px; }
  h1 { font-size: 17px; font-weight: 500; margin: 0 0 8px; }
  p { margin: 0 0 6px; opacity: .7; }
  code { font: 11px ui-monospace, Menlo, monospace; opacity: .5; word-break: break-all; }
</style>
<div class="card">
  <h1>${escape(opts.serviceName)} is no longer in the catalog</h1>
  <p>Hangar doesn't know what to load for it, so this pane has nothing to show.</p>
  <p>Give it a URL of its own in Settings → Connections, or remove it.</p>
  <code>${escape(opts.catalogId)}</code>
</div>`)}`;
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
  return `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html>
<meta charset="utf-8">
<style>
  :root { color-scheme: dark light; }
  body {
    margin: 0; height: 100vh; display: grid; place-items: center;
    font: 14px/1.6 -apple-system, BlinkMacSystemFont, sans-serif;
    background: #1b1b1f; color: #e8e8ea;
  }
  @media (prefers-color-scheme: light) { body { background: #f4f4f6; color: #1b1b1f; } }
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
<div class="card">
  <h1>${escape(opts.serviceName)} tried to leave</h1>
  <p><strong>${escape(opts.host)}</strong> isn't on this service's allowed list, so Hangar opened it in your browser instead.</p>
  <p>If it's part of signing in, allow it and try again.</p>
  <code>${escape(opts.url)}</code>
  <div class="actions">
    <button onclick="window.__hangar && window.__hangar.allowHost()">Allow ${escape(opts.host)}</button>
    <button onclick="window.__hangar && window.__hangar.retry()">Back to ${escape(opts.serviceName)}</button>
  </div>
</div>`)}`;
}

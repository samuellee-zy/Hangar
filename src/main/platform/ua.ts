import { app, session } from 'electron';

/**
 * The entire user-agent story, settled empirically in the Phase 0 spike
 * (`spikes/google-login/`, see results.md).
 *
 * Strip the Electron token and nothing else. This is Rambox 2.7.0's verbatim production code —
 * it keeps the app name (`Hangar/0.1.0`) in the string, exactly as Rambox keeps `Rambox/2.7.0`,
 * and Google accepts it. Gmail signed in under this and stayed signed in across relaunches.
 *
 * Deliberately NOT done, because the spike showed each to be unnecessary:
 *   - stripping the app name as well
 *   - a hardcoded Chrome UA
 *   - host-scoped UA swaps on accounts.google.com
 *   - Sec-CH-UA client-hint injection (electron#34762 is still open; Rambox ships without it)
 *   - signing in via a separate BrowserWindow
 *
 * The untouched Electron UA also passed both headless checkpoints, so Google is not keying on the
 * Electron token at the entry point at all. Ferdium's chronic failures are almost certainly its
 * much older Electron rather than anything we need to defend against.
 *
 * One service disagrees: WhatsApp refuses any product token beside `Chrome/…`, the app name
 * included, so its page is given the plain Chrome string instead (core/services/user-agent.ts).
 * Per page, and only for entries that ask — the default stays what Google is known to accept.
 *
 * Call this first thing inside `app.whenReady()`. It cannot run any earlier — reading
 * `session.defaultSession` before the app is ready throws — but it must run before any session or
 * view is created, or those get the unscrubbed UA.
 */
export function applyUserAgent(): string {
  const ua = session.defaultSession.getUserAgent().replace(/Electron\/([0-9]\.?)+\s/gi, '');
  session.defaultSession.setUserAgent(ua);
  app.userAgentFallback = ua;
  return ua;
}

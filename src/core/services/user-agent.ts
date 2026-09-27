/**
 * The user agent a service's page is given, when it isn't the app's default.
 *
 * The default is Chromium's minus the `Electron/…` token, keeping the app's own `Hangar/…` — what
 * Rambox ships, and what Google sign-in accepts (main/platform/ua.ts). WhatsApp doesn't: with any
 * product token beside `Chrome/…` it says "WhatsApp works with Google Chrome 100+" and stops, at
 * Chrome 150. A catalog entry marked `plainUserAgent` gets exactly what Chrome sends. Ferdium's
 * WhatsApp recipe strips its app name the same way.
 *
 * Pure, so the rule is testable without a window.
 */

/** `ua` without the `<appName>/<version>` token. */
export function withoutAppToken(ua: string, appName: string): string {
  const escaped = appName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return ua.replace(new RegExp(`\\b${escaped}\\/\\S+\\s+`, 'gi'), '');
}

/**
 * What to set on a service's page, or null to leave the default. The service's own setting wins —
 * it's the one somebody typed.
 */
export function userAgentFor(
  svc: { userAgent?: string },
  entry: { plainUserAgent?: boolean } | undefined,
  defaultUa: string,
  appName: string,
): string | null {
  if (svc.userAgent?.trim()) return svc.userAgent;
  if (entry?.plainUserAgent) return withoutAppToken(defaultUa, appName);
  return null;
}

import type { ServiceInstance } from '@shared/types';

/**
 * Validates an `update-service` patch before it reaches config.
 *
 * The handler was a bare `Object.assign`, so whatever arrived was written verbatim: a zoom of
 * `NaN`, a `notificationLevel` of `"quiet"`, an `id` that renamed the service out from under every
 * map keyed on it. None of that throws. It lands in `config.json`, survives a restart, and the
 * symptom shows up somewhere else entirely — which is the expensive kind of bug.
 *
 * Allowlisted rather than deny-listed, so a field added to `ServiceInstance` later is not writable
 * over IPC until someone decides it should be. `id` and `accountId` are absent deliberately:
 * changing either is an identity change, not an edit, and `accountId` in particular decides which
 * cookie jar the service uses.
 *
 * Unknown keys and bad values are dropped rather than rejecting the whole patch. A single bad
 * field should not silently discard the good ones beside it.
 */

const HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const bool = (v: unknown): boolean | undefined => (typeof v === 'boolean' ? v : undefined);

/** Hosts are compared with a leading-dot suffix match, so anything but a bare hostname is a bug. */
export function isValidHost(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const host = value.trim().toLowerCase();
  // A bare public suffix would allowlist an entire TLD. `HOST` already requires a dot, which
  // catches `com`; this catches the length-1 label case that slips past it.
  return host.length <= 253 && HOST.test(host) && host.split('.').length >= 2;
}

export function sanitiseServicePatch(patch: unknown): Partial<ServiceInstance> {
  if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) return {};
  const raw = patch as Record<string, unknown>;
  const out: Partial<ServiceInstance> = {};

  if ('name' in raw) {
    const name = str(raw.name)?.trim();
    // An empty name renders as an unlabelled tile with an empty aria-label — unreachable by
    // keyboard search and indistinguishable from a rendering failure.
    if (name) out.name = name.slice(0, 120);
  }

  if ('zoom' in raw && typeof raw.zoom === 'number' && Number.isFinite(raw.zoom)) {
    // Clamped rather than rejected: the same bounds the Settings control enforces, so a value from
    // a synced config written by an older version lands somewhere usable.
    out.zoom = Math.min(2, Math.max(0.5, raw.zoom));
  }

  if ('mutedUntil' in raw) {
    const until = raw.mutedUntil;
    if (typeof until === 'number' && Number.isFinite(until) && until > 0) out.mutedUntil = until;
  }

  if ('notificationLevel' in raw) {
    const level = str(raw.notificationLevel);
    if (level === 'all' || level === 'badge' || level === 'muted') out.notificationLevel = level;
  }

  for (const key of ['hibernate', 'notifications', 'allowMedia', 'keepRunning'] as const) {
    if (!(key in raw)) continue;
    const value = bool(raw[key]);
    if (value !== undefined) out[key] = value;
  }

  for (const key of ['customCss', 'customJs', 'userAgent', 'unreadSelector', 'color'] as const) {
    if (!(key in raw)) continue;
    const value = str(raw[key]);
    if (value !== undefined) out[key] = value;
  }

  if ('url' in raw) {
    const url = str(raw.url)?.trim();
    // http(s) only. A `file:` or `javascript:` URL here would be running with the service preload
    // attached, which is a far larger grant than "point this pane somewhere else".
    if (url && /^https?:\/\//i.test(url)) out.url = url;
  }

  if ('keyboardPassthrough' in raw && Array.isArray(raw.keyboardPassthrough)) {
    out.keyboardPassthrough = raw.keyboardPassthrough.filter(
      (chord): chord is string => typeof chord === 'string'
    );
  }

  for (const key of ['allowedHosts', 'extraAllowedHosts'] as const) {
    if (!(key in raw) || !Array.isArray(raw[key])) continue;
    // Deduplicated and lowercased, because the allowlist check is case-sensitive and a host that
    // is present twice in two casings reads as two different rules.
    const hosts = (raw[key] as unknown[]).filter(isValidHost).map((h) => h.trim().toLowerCase());
    out[key] = [...new Set(hosts)];
  }

  if ('cookieTtlDays' in raw && typeof raw.cookieTtlDays === 'number') {
    if (Number.isFinite(raw.cookieTtlDays) && raw.cookieTtlDays >= 0) {
      out.cookieTtlDays = Math.min(400, Math.floor(raw.cookieTtlDays));
    }
  }

  return out;
}

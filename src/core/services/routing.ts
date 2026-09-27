import type { ServiceInstance } from '@shared/types';

/**
 * Which of your services a link belongs in, if any.
 *
 * A link that leaves a service — a Jira ticket pasted into Slack, a Doc shared in Gmail — went to
 * the system browser, even when you had that very service open in Hangar, signed in, one tile away.
 * With link routing on, it opens there instead.
 *
 * Matched against each service's *start page*, not its allowlist. Allowlists are full of sign-in
 * hosts — every Google service allows accounts.google.com — so matching on them would send a link
 * to whichever Google service happened to come first. A start page says what the service *is*:
 * Docs is docs.google.com/document, Sheets is docs.google.com/spreadsheets, and the longest path
 * prefix that fits decides between them.
 *
 * Pure: the caller supplies each service's resolved start URL, so custom connections, per-service
 * URL overrides and catalog defaults all look the same here.
 */

export interface RoutableService {
  id: string;
  /** The URL the service opens on — `resolveUrl(svc)`. */
  startUrl: string;
}

/** The part of a start path that identifies the product rather than a page inside it. */
function productPrefix(pathname: string): string {
  // `/mail/`, `/document/`, `/spreadsheets/` — the first segment. Deeper segments are pages
  // (`/d/abc/edit`) or per-user routing (`/u/0/`), and matching on them would miss every link.
  const first = pathname.split('/').filter(Boolean)[0];
  return first ? `/${first}` : '';
}

export function routeTarget(
  rawUrl: string,
  services: readonly RoutableService[],
  fromServiceId: string,
): string | null {
  let link: URL;
  try {
    link = new URL(rawUrl);
  } catch {
    return null;
  }
  if (link.protocol !== 'https:' && link.protocol !== 'http:') return null;

  let best: { id: string; score: number } | null = null;
  for (const svc of services) {
    if (svc.id === fromServiceId) continue;
    let start: URL;
    try {
      start = new URL(svc.startUrl);
    } catch {
      continue;
    }
    // The link's host has to be the service's own host or beneath it. `www.` on either side is
    // cosmetic.
    const host = link.hostname.replace(/^www\./, '');
    const own = start.hostname.replace(/^www\./, '');
    if (host !== own && !host.endsWith(`.${own}`)) continue;

    const prefix = productPrefix(start.pathname);
    if (prefix && !(link.pathname === prefix || link.pathname.startsWith(`${prefix}/`))) continue;

    // Exact host beats a parent domain; a matching product path beats none.
    const score = (host === own ? 2 : 1) * 100 + prefix.length;
    if (!best || score > best.score) best = { id: svc.id, score };
  }
  return best?.id ?? null;
}

/** The routable view of a config's services. */
export const routable = (
  services: readonly ServiceInstance[],
  startUrlOf: (svc: ServiceInstance) => string,
): RoutableService[] => services.map((svc) => ({ id: svc.id, startUrl: startUrlOf(svc) }));

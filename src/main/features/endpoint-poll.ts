import { net } from 'electron';
import {
  endpointDue,
  pollJitterMs,
  resolveEndpoint,
  unreadFromEndpoint,
  type EndpointResponse,
} from '@core/notify/endpoint';
import { isAllowedHost, sessionFor } from '@main/platform/session';
import { catalogById } from '@shared/catalog';
import type { EndpointRule, ServiceInstance } from '@shared/types';

/**
 * Asking a sleeping service how much mail it has.
 *
 * Both mechanisms in `core/notify/unread.ts` read a rendered page, so both need a live view. A
 * hibernated service has none — and hibernation is what makes a rail of twenty services
 * affordable, so the count you most want is for the service least able to report one. This closes
 * that, using nothing but the cookies its own partition already holds.
 *
 * **Only while there is no live view.** Not a performance choice: title and DOM detection also
 * write an absolute count, and two absolute sources for one service is a badge that flips between
 * whichever answered last. The live page is fresher and free, so the endpoint waits for it to go
 * away. That also means the request rate is bounded by how much you hibernate, which is the right
 * shape — an app you have open all day never calls anything.
 */
export class EndpointPoller {
  private lastPolledAt = new Map<string, number>();
  private inFlight = new Set<string>();
  private disposed = false;

  constructor(
    /** Services with no live view right now, and therefore nothing better to read. */
    private readonly sleepingServices: () => ServiceInstance[],
    private readonly report: (serviceId: string, count: number) => void,
    /**
     * Injected so the scheduling can be tested without a network or a Chromium session. The default
     * *is* the feature and is covered end to end instead — see e2e/app.spec.ts.
     */
    private readonly request: (
      svc: ServiceInstance,
      rule: EndpointRule
    ) => Promise<EndpointResponse | null> = borrowedFetch
  ) {}

  dispose(): void {
    this.disposed = true;
    this.lastPolledAt.clear();
  }

  /** A service waking up should be read from its page, and re-polled promptly when it sleeps again. */
  forget(serviceId: string): void {
    this.lastPolledAt.delete(serviceId);
  }

  async sweep(now = Date.now()): Promise<void> {
    if (this.disposed) return;
    for (const svc of this.sleepingServices()) {
      const rule = eligibleRule(svc);
      if (!rule) continue;
      if (!endpointDue(rule, this.lastPolledAt.get(svc.id), now, pollJitterMs(svc.id, rule)))
        continue;
      // A slow endpoint must not be asked again on the next sweep, or a service that takes two
      // minutes to answer accumulates one outstanding request per sweep forever.
      if (this.inFlight.has(svc.id)) continue;

      this.lastPolledAt.set(svc.id, now);
      this.inFlight.add(svc.id);
      try {
        const count = unreadFromEndpoint(rule, await this.request(svc, rule));
        // null is "no information" — signed out, rate-limited, or a response shape that changed.
        // Reporting zero for any of those silently clears a real count.
        if (count !== null && !this.disposed) this.report(svc.id, count);
      } catch (err) {
        console.error(`[endpoint] ${svc.name}:`, err instanceof Error ? err.message : err);
      } finally {
        this.inFlight.delete(svc.id);
      }
    }
  }
}

/**
 * The request itself, and the reason the feature is called session-borrowed.
 *
 * `session.fetch` issues it on that partition's cookie jar, so being signed in to the service
 * inside Hangar is what authenticates it. Nothing here holds a credential; signing out breaks it,
 * which is the correct behaviour rather than something to handle.
 */
async function borrowedFetch(
  svc: ServiceInstance,
  rule: EndpointRule
): Promise<EndpointResponse> {
  const ses = sessionFor(svc);
  const controller = new AbortController();
  // A service that accepts the connection and never answers would otherwise hold `inFlight`
  // forever, and this service would stop being polled for the rest of the session.
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await ses.fetch(rule.url, {
      signal: controller.signal,
      // The count as it stands, not whatever Chromium cached five minutes ago.
      cache: 'no-store',
      // Some endpoints redirect to a login page on an expired session. Following it would give a
      // 200 full of HTML, which the extractor then fails on — the same "no information" answer,
      // reached more slowly and after handing the cookies to whatever the redirect named.
      redirect: 'error',
      headers: { Accept: 'application/json, text/xml, */*' },
    });
    return { status: response.status, body: await response.text() };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * The rule for a service, or null if it must not be called.
 *
 * Exported for the test, because every clause is a way this feature could do something the user did
 * not ask for.
 */
export function eligibleRule(svc: ServiceInstance): EndpointRule | null {
  // Muting a service means not hearing from it, and a background request on its behalf is the
  // clearest possible case of hearing from it.
  if (!svc.notifications || svc.notificationLevel === 'muted') return null;

  const rule = resolveEndpoint(catalogById(svc.catalogId)?.unread?.endpoint, svc.unreadEndpoint);
  if (!rule?.url) return null;

  // The guard that matters. Cookies go out with this request, so the URL has to belong to the
  // service they authenticate — otherwise a typo, an imported config or a synced one is a
  // credentialled request to a host of someone else's choosing.
  if (!isAllowedHost(svc, rule.url)) {
    console.error(`[endpoint] refusing ${rule.url} — not on ${svc.name}'s allowlist`);
    return null;
  }

  // `net.isOnline` is cheap and wrong only in the harmless direction: offline is certain, online is
  // a guess. Skipping a sweep beats ten failed fetches and ten error lines per minute.
  if (!net.isOnline()) return null;

  return rule;
}

/**
 * Asking a service's own API how many unread it has, using the login you already gave it.
 *
 * **The gap this fills.** The two detection mechanisms in `unread.ts` both read a rendered page, so
 * both need a live `WebContentsView`. A hibernated service has none by definition — and hibernation
 * is the feature that makes a rail of twenty services affordable, so the services most likely to be
 * asleep are exactly the ones you most want a count for. Web Push covers this, but only for someone
 * who has stood up a Firebase project ([docs/push.md](../../../docs/push.md)), which is most of a
 * setup for something that should be a background GET.
 *
 * **Session-borrowed, not authenticated.** No tokens, no OAuth client, no secrets in the source:
 * the request goes out through the service's own Chromium partition, so it carries the cookies that
 * partition already holds. If you are signed in, so is the request; if you sign out, it starts
 * failing, which is the correct behaviour rather than something to handle. That is the whole design
 * — everything else here is the guard rails around it.
 *
 * **Rules are data, for the same reason DOM rules are.** A URL and a declarative extractor, run by
 * one tested function, rather than a fetch-and-parse script per service.
 */

import type { EndpointRule } from '../../shared/types';
import { countFromBadgeText } from './unread';

/**
 * `EndpointRule` lives in `shared/types` beside the catalog that declares it. What matters here:
 *
 *   - `url` must be on the service's own allowlist, enforced by the caller. A rule pointing at a
 *     third party would be sending that service's cookies somewhere it never agreed to.
 *   - `extract.json` is a dotted path — `counts.total`, `items.0.unread`. A number at the end is
 *     the count, a string is parsed like a badge, and an array's length is the count, which covers
 *     the common "return the unread items" shape.
 *   - `extract.regex` is for endpoints that are not JSON. Gmail's Atom feed is why it exists.
 */
export type { EndpointRule };

/**
 * Nobody's inbox needs to be checked more than once a minute, and a rule with a typo'd interval
 * should cost the service one request a minute rather than becoming an accidental load test that
 * gets the user rate-limited or locked out.
 */
export const MIN_POLL_SECONDS = 60;
const DEFAULT_POLL_SECONDS = 300;

export function pollIntervalSeconds(rule: EndpointRule): number {
  const requested = rule.everySeconds ?? DEFAULT_POLL_SECONDS;
  return Number.isFinite(requested) ? Math.max(MIN_POLL_SECONDS, requested) : DEFAULT_POLL_SECONDS;
}

/**
 * A stable per-service share of the interval, so services don't stay in lockstep.
 *
 * Waking from sleep makes every sleeping service overdue at the same instant, and they all get the
 * same `lastPolledAt` from the sweep that clears the backlog. From then on they ask together, for
 * as long as the app runs — which is the one access pattern most likely to look automated to the
 * services on the other end.
 *
 * Derived from the service id rather than `Math.random`, so the schedule is reproducible and a test
 * can assert a specific offset instead of tolerating a range.
 *
 * Only ever *lengthens* the gap. `MIN_POLL_SECONDS` is a floor on how often a service may be asked,
 * so drifting later is always safe and drifting earlier would not be.
 */
const JITTER_SHARE = 0.2;

export function pollJitterMs(serviceId: string, rule: EndpointRule): number {
  // FNV-1a. Cheap, no dependency, and well spread for short ASCII keys like a service id.
  let hash = 2166136261;
  for (let i = 0; i < serviceId.length; i++) {
    hash ^= serviceId.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  const fraction = (hash >>> 0) / 2 ** 32;
  return Math.floor(fraction * pollIntervalSeconds(rule) * 1000 * JITTER_SHARE);
}

export function endpointDue(
  rule: EndpointRule,
  lastPolledAt: number | undefined,
  now: number,
  jitterMs = 0
): boolean {
  if (lastPolledAt === undefined) return true;
  // A clock that jumped backwards — a laptop waking in another timezone — would otherwise park the
  // next poll days out.
  if (lastPolledAt > now) return true;
  return now - lastPolledAt >= pollIntervalSeconds(rule) * 1000 + jitterMs;
}

/** What a fetch produced. Deliberately not a `Response`, so this stays testable without a network. */
export interface EndpointResponse {
  status: number;
  body: string;
}

/**
 * The count a response implies, or null for "no information".
 *
 * **A failure is never zero.** Signed out is a 401, rate-limited is a 429, and a service being down
 * is a 503 — reading any of those as an empty inbox would silently clear a real count and look like
 * the badge being broken. Only a successful response the extractor understood produces a number.
 */
export function unreadFromEndpoint(
  rule: EndpointRule,
  response: EndpointResponse | null
): number | null {
  if (!response || response.status < 200 || response.status >= 300) return null;

  if ('regex' in rule.extract) {
    let match: RegExpMatchArray | null;
    try {
      match = response.body.match(new RegExp(rule.extract.regex));
    } catch {
      return null;
    }
    if (!match) return null;
    // No capture group means the rule is a presence test: it matched, so there is something.
    return match[1] === undefined ? 1 : countFromBadgeText(match[1]);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(response.body);
  } catch {
    return null;
  }
  return countFromJson(resolvePath(parsed, rule.extract.json));
}

function resolvePath(root: unknown, path: string): unknown {
  let current = root;
  // An empty path means the whole body, which is how an endpoint returning a bare number works.
  for (const segment of path.split('.').filter(Boolean)) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function countFromJson(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : null;
  // The "here are your unread items" shape. Length is the count, and an empty array is a real zero.
  if (Array.isArray(value)) return value.length;
  if (typeof value === 'string') return countFromBadgeText(value);
  // `false`/`true` for "any unread?", which some endpoints answer with.
  if (typeof value === 'boolean') return value ? 1 : 0;
  // A path that resolved to nothing is a rule that no longer matches the response — the service
  // changed its shape. Silence, not zero.
  return null;
}

/**
 * The rule to poll for a service, if any.
 *
 * Same absent-versus-empty contract as the unread selector: absent follows the catalog, and `null`
 * is the deliberate "do not call anything", which is how you stop a background request without
 * turning the service off.
 */
export function resolveEndpoint(
  catalogRule: EndpointRule | undefined,
  override: EndpointRule | null | undefined
): EndpointRule | null {
  if (override === undefined) return catalogRule ?? null;
  return override;
}

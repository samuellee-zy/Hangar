/**
 * Web Push policy — pure, so all of it is testable without a socket, a Firebase project, or a
 * service that feels like sending you a message today.
 *
 * ## Why this exists
 *
 * Hibernation currently means *going silent* on a service. The notification parity work in Phase
 * 3.1 forwards `window.Notification` from a loaded page, which is exactly nothing when the page
 * isn't loaded. Web Push is the only way a sleeping — or never-opened — service can still reach
 * you, and it's what makes hibernation a saving rather than a trade-off.
 *
 * ## How it works
 *
 * A site calls `pushManager.subscribe({applicationServerKey})` and gets back a `PushSubscription`
 * — an endpoint plus two keys. It POSTs that to its own servers. Later its server encrypts a
 * payload against those keys and POSTs it to the endpoint. The push service routes it to whoever
 * holds the matching registration.
 *
 * Hangar registers with FCM *on the site's behalf*, hands the site an FCM endpoint, and holds the
 * receiving socket in main. The site's server pushes; we decrypt in main and raise a native
 * notification. The page never needs to be open.
 *
 * ## The constraint that shapes everything here
 *
 * FCM web registration is gated on a **Firebase project** — `apiKey`, `appId` and `projectId` are
 * all required by `firebaseinstallations.googleapis.com`. Google decommissioned the older
 * sender-id-only subscribe path, so there is no way to register anonymously any more.
 *
 * Hangar can't ship a project of its own: the `apiKey` would sit in the repo, and every user's
 * pushes would route through one quota that anyone could get revoked. So the credentials are
 * **supplied by the user** — a free Firebase project takes a few minutes to create — and the
 * feature stays off until they are. See `docs/push.md`.
 */

import type { MessageEnvelope } from '@core/push/types';

/** The four values from a Firebase web app config. All required by the registration endpoint. */
export interface FirebaseConfig {
  projectId: string;
  appId: string;
  apiKey: string;
  messagingSenderId: string;
}

export const EMPTY_FIREBASE_CONFIG: FirebaseConfig = {
  projectId: '',
  appId: '',
  apiKey: '',
  messagingSenderId: '',
};

export type ConfigStatus = 'unset' | 'incomplete' | 'ready';

/**
 * `unset` and `incomplete` are deliberately different states. Nothing filled in means the user
 * hasn't started; *some* fields filled in means they pasted a partial config and Settings should
 * say which field is missing rather than silently doing nothing.
 */
export function firebaseConfigStatus(config: Partial<FirebaseConfig> | null): ConfigStatus {
  if (!config) return 'unset';
  const fields = ['projectId', 'appId', 'apiKey', 'messagingSenderId'] as const;
  const filled = fields.filter((f) => typeof config[f] === 'string' && config[f]!.trim() !== '');
  if (filled.length === 0) return 'unset';
  return filled.length === fields.length ? 'ready' : 'incomplete';
}

/** Which fields are still blank, so Settings can name them instead of just refusing. */
export function missingFirebaseFields(config: Partial<FirebaseConfig> | null): string[] {
  const fields = ['projectId', 'appId', 'apiKey', 'messagingSenderId'] as const;
  return fields.filter((f) => !config?.[f] || config[f]!.trim() === '');
}

export interface EligibilityContext {
  /** Global Web Push toggle. */
  pushEnabled: boolean;
  /** Firebase credentials present and complete. */
  configStatus: ConfigStatus;
  /** The service's own notification toggle. */
  serviceNotifications: boolean;
  /** `muted` opts a service out of everything, push included. */
  level: 'all' | 'muted';
}

/**
 * Push is opt-in at every level. Intercepting `pushManager.subscribe` changes how a site behaves —
 * its own service worker stops seeing push events — so it never happens to a service that hasn't
 * asked for notifications.
 */
export function pushEligible(ctx: EligibilityContext): boolean {
  if (!ctx.pushEnabled) return false;
  if (ctx.configStatus !== 'ready') return false;
  if (!ctx.serviceNotifications) return false;
  if (ctx.level === 'muted') return false;
  return true;
}

/**
 * FCM replays unacknowledged messages on reconnect, which is the correct behaviour for a transport
 * and the wrong behaviour for a notification centre — a flaky connection would otherwise show you
 * the same DM four times.
 *
 * The list is capped and trimmed oldest-first. Unbounded, it grows for the process lifetime and
 * gets written to disk on every credential change.
 */
export const PERSISTENT_ID_CAP = 512;

export function dedupePersistentIds(
  seen: string[],
  incoming: string | undefined,
  cap: number = PERSISTENT_ID_CAP
): { fresh: boolean; seen: string[] } {
  // `persistentId` is typed as a string but comes off the wire, and FCM doesn't guarantee it.
  // Recording a missing one meant a run of them filled the cap and evicted the real ids this list
  // exists to remember — quietly turning deduplication off. Deliver the message (it's still a
  // message), just don't pretend we can recognise it again.
  if (!incoming) return { fresh: true, seen };

  if (seen.includes(incoming)) return { fresh: false, seen };
  const next = [...seen, incoming];
  // Trim from the front: the oldest ids are the least likely to be replayed.
  return { fresh: true, seen: next.length > cap ? next.slice(next.length - cap) : next };
}

export interface PushNotificationContent {
  title: string;
  body: string;
  /** Collapses repeat notifications from the same conversation, as the web API does. */
  tag?: string;
  /** A URL to open when clicked, if the payload names one. */
  url?: string;
}

/**
 * A web push payload is whatever the site's own service worker expects — there is no schema. So
 * this tries the shapes that actually occur, in order, and gives up rather than guessing.
 *
 * `fallbackTitle` is the service name: a notification that says "Slack" and nothing else is still
 * better than a silent drop, because it tells you where to look.
 */
export function extractNotification(
  message: unknown,
  fallbackTitle: string
): PushNotificationContent | null {
  if (!message || typeof message !== 'object') return null;
  const msg = message as Record<string, any>;

  // 1. An FCM `notification` block — the shape FCM itself defines.
  const candidates: Array<Record<string, any> | undefined> = [
    msg.notification,
    // 2. Sites that nest their own payload under `data`, sometimes as a JSON string.
    parseMaybeJson(msg.data?.notification) ?? msg.data?.notification,
    msg.data,
    // 3. The payload at the top level, which is what most service workers actually send.
    msg,
  ];

  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object') continue;
    const title = firstString(candidate.title, candidate.subject, candidate.heading);
    const body = firstString(candidate.body, candidate.message, candidate.text, candidate.alert);
    if (!title && !body) continue;
    return {
      // A body with no title still deserves the service name attached, or you can't tell
      // which of four Slacks it came from.
      title: title ?? fallbackTitle,
      body: body ?? '',
      tag: firstString(candidate.tag, candidate.collapse_key, candidate.thread_id),
      url: firstString(candidate.url, candidate.click_action, candidate.launchUrl),
    };
  }

  return null;
}

function firstString(...values: unknown[]): string | undefined {
  for (const v of values) {
    if (typeof v === 'string' && v.trim() !== '') return v;
  }
  return undefined;
}

function parseMaybeJson(value: unknown): Record<string, any> | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Reconnect backoff. Capped at 5 minutes — a laptop that closes its lid overnight would otherwise
 * come back with an hours-long delay computed while it was asleep, and never reconnect.
 */
export const MAX_RECONNECT_DELAY_MS = 5 * 60_000;

export function reconnectDelayMs(attempt: number): number {
  const base = 2_000 * Math.pow(2, Math.max(0, attempt));
  return Math.min(base, MAX_RECONNECT_DELAY_MS);
}

/**
 * A registration is identified by the service **and** the VAPID key. If a site rotates its
 * application server key the old registration is dead — FCM rejects pushes signed with a key that
 * doesn't match the one the subscription was created with — so a changed key has to mean a new
 * registration, not a reused one.
 */
export function subscriptionKey(serviceId: string, vapidKey: string): string {
  return `${serviceId}::${vapidKey}`;
}

/** Stored per service so a restart doesn't re-register and invalidate the site's subscription. */
export interface StoredRegistration {
  serviceId: string;
  vapidKey: string;
  /** Opaque `Credentials` from the receiver library. Round-tripped, never interpreted here. */
  credentials: unknown;
  seenIds: string[];
}

export function findRegistration(
  registrations: StoredRegistration[],
  serviceId: string,
  vapidKey: string
): StoredRegistration | undefined {
  return registrations.find((r) => r.serviceId === serviceId && r.vapidKey === vapidKey);
}

/**
 * Replaces by service id, not by `subscriptionKey` — a service has at most one live registration,
 * so a rotated VAPID key must *evict* the old entry rather than accumulate beside it.
 */
export function upsertRegistration(
  registrations: StoredRegistration[],
  next: StoredRegistration
): StoredRegistration[] {
  const rest = registrations.filter((r) => r.serviceId !== next.serviceId);
  return [...rest, next];
}

/** Registrations whose service no longer exists, so their sockets can be closed and rows dropped. */
export function staleRegistrations(
  registrations: StoredRegistration[],
  liveServiceIds: string[]
): StoredRegistration[] {
  return registrations.filter((r) => !liveServiceIds.includes(r.serviceId));
}

export type { MessageEnvelope };

import PushReceiver from '@eneris/push-receiver';
import type { Types as PushTypes } from '@eneris/push-receiver/dist/client';
import {
  dedupePersistentIds,
  findRegistration,
  reconnectDelayMs,
  staleRegistrations,
  upsertRegistration,
  type FirebaseConfig,
  type StoredRegistration,
} from '@core/push/policy';
import type { PushSubscriptionData } from '@core/push/types';

/**
 * Owns the FCM sockets. Everything that needs a decision lives in `push.ts` — this file is the
 * side effects: registering, connecting, reconnecting, persisting.
 *
 * One `PushReceiver` per subscribed service. They can't be shared: a registration is bound to the
 * VAPID key it was created with, and a push signed by Slack's key is only routable to the
 * registration Slack was given. So a service is a socket.
 *
 * That is a real cost — five push-enabled services means five TLS connections to `mtalk.google.com`
 * with their own heartbeats. It's why push is opt-in per service rather than on by default.
 */

export interface PushDeps {
  /** Read the user's Firebase project config. */
  firebase: () => FirebaseConfig;
  /** Persisted registrations, so a restart doesn't invalidate every subscription. */
  load: () => StoredRegistration[];
  save: (registrations: StoredRegistration[]) => void;
  /** Raise a notification. Routed through the same policy as an in-page one. */
  deliver: (serviceId: string, message: unknown) => void;
  log: (message: string) => void;
}

export class PushManager {
  private clients = new Map<string, PushReceiver>();
  /**
   * Services torn down while a `connect()` was still in flight. `connect` persists after two
   * awaits, so an `unsubscribe` in between would be undone — the registration written back into
   * config with a live socket behind it, for a service the user had just deleted.
   */
  private abandoned = new Set<string>();
  private timers = new Map<string, NodeJS.Timeout>();
  private attempts = new Map<string, number>();
  private registrations: StoredRegistration[] = [];
  private started = false;

  constructor(private deps: PushDeps) {}

  /**
   * Reconnects everything already registered. Called once the window exists, not at module load —
   * a socket that opens before there's anywhere to show a notification just drops messages.
   */
  start(liveServiceIds: string[]): void {
    if (this.started) return;
    this.started = true;
    this.registrations = this.deps.load();

    // Drop registrations for services that were removed while we weren't running. Left in place,
    // they'd reconnect sockets for things the user deleted.
    const stale = staleRegistrations(this.registrations, liveServiceIds);
    if (stale.length > 0) {
      this.deps.log(`push: dropping ${stale.length} registration(s) for removed services`);
      this.registrations = this.registrations.filter((r) => !stale.includes(r));
      this.deps.save(this.registrations);
    }

    this.connectAll();
  }

  /**
   * Drops every socket and dials again.
   *
   * A laptop waking has no live connections, but nothing has noticed yet: the peer vanished without
   * a FIN, so `ON_DISCONNECT` waits on the 5-minute heartbeat to miss, and the backoff can add five
   * more on top. That is a ten-minute hole in notifications after every lid open, and the only
   * symptom is messages arriving late — which reads as the service being slow, not as a bug here.
   * Reconnecting deliberately costs one round trip per service.
   */
  reconnectAll(): void {
    if (!this.started || !this.registrations.length) return;
    this.deps.log(`push: reconnecting ${this.registrations.length} socket(s) after wake`);
    // `connect` tears the existing client down first, which also clears any pending retry timer and
    // resets the backoff — so a socket already deep into its retry schedule is pulled back to now.
    this.connectAll();
  }

  private connectAll(): void {
    for (const registration of this.registrations) {
      void this.connect(registration).catch((error) => {
        this.deps.log(`push: reconnect failed for ${registration.serviceId}: ${String(error)}`);
      });
    }
  }

  /**
   * Called from the intercepted `pushManager.subscribe()`. Returns the endpoint and keys for the
   * site to POST to its own servers.
   *
   * Reuses a stored registration when the VAPID key matches. Re-registering on every page load
   * would hand the site a new endpoint each time and orphan the previous one, which for a chat app
   * means duplicate delivery to endpoints nobody is listening on.
   */
  async subscribe(serviceId: string, vapidKey: string): Promise<PushSubscriptionData> {
    const existing = findRegistration(this.registrations, serviceId, vapidKey);
    if (existing) {
      const client = this.clients.get(serviceId);
      const credentials = (existing.credentials ?? null) as PushTypes.Credentials | null;
      if (client && credentials) return toSubscription(credentials);
      // Stored but not connected — connect now and return the stored keys.
      if (credentials) {
        this.connect(existing).catch((err: unknown) =>
          this.deps.log(`${serviceId}: reconnect failed — ${String(err)}`),
        );
        return toSubscription(credentials);
      }
    }

    const registration: StoredRegistration = {
      serviceId,
      vapidKey,
      credentials: null,
      seenIds: [],
    };
    const credentials = await this.connect(registration);
    return toSubscription(credentials);
  }

  /** Tears down one service's socket and forgets its registration — used when a service is removed. */
  unsubscribe(serviceId: string): void {
    this.abandoned.add(serviceId);
    this.teardown(serviceId);
    const before = this.registrations.length;
    this.registrations = this.registrations.filter((r) => r.serviceId !== serviceId);
    if (this.registrations.length !== before) this.deps.save(this.registrations);
  }

  /** Everything down, sockets closed. Called on quit and when push is switched off. */
  stopAll(): void {
    for (const serviceId of [...this.clients.keys()]) this.teardown(serviceId);
    this.started = false;
  }

  get activeCount(): number {
    return this.clients.size;
  }

  private teardown(serviceId: string): void {
    const timer = this.timers.get(serviceId);
    if (timer) clearTimeout(timer);
    this.timers.delete(serviceId);
    this.attempts.delete(serviceId);
    const client = this.clients.get(serviceId);
    if (client) {
      try {
        client.destroy();
      } catch {
        // destroy() throws if the socket is already gone; that's the state we wanted anyway.
      }
    }
    this.clients.delete(serviceId);
  }

  private async connect(registration: StoredRegistration): Promise<PushTypes.Credentials> {
    const { serviceId, vapidKey } = registration;
    // A re-subscribe after a removal is legitimate; clear the tombstone.
    this.abandoned.delete(serviceId);
    // A second connect for the same service would leave the first socket orphaned and delivering
    // duplicates, since nothing else holds a reference to it.
    this.teardown(serviceId);

    const client = new PushReceiver({
      firebase: this.deps.firebase(),
      vapidKey,
      credentials: (registration.credentials ?? undefined) as PushTypes.Credentials | undefined,
      // Seeding these tells FCM what we've already processed, so it doesn't replay the backlog.
      persistentIds: registration.seenIds,
      // Long enough not to be chatty, short enough that a dead NAT binding is noticed.
      heartbeatIntervalMs: 5 * 60_000,
    });

    this.clients.set(serviceId, client);

    // Credentials rotate. Not persisting a rotation means the next launch presents a stale
    // registration, FCM rejects it, and push silently stops working for that service.
    client.onCredentialsChanged(({ newCredentials }) => {
      this.persist({ ...this.current(serviceId, vapidKey), credentials: newCredentials });
    });

    client.onNotification((envelope) => this.onMessage(serviceId, vapidKey, envelope));

    client.on('ON_DISCONNECT', () => this.scheduleReconnect(serviceId, vapidKey));

    client.on('ON_CONNECT', () => {
      // Reset the backoff only on a *successful* connection, so a flapping socket still backs off.
      this.attempts.delete(serviceId);
      // The receiver retries a dropped socket by itself, and so do we — one drop was two
      // reconnects. Whichever lands first wins: the library's own retry cancels ours here, and ours
      // tears the library's down (`teardown` → `destroy`, which clears its timer) if it fires first.
      // Ours stays because the library's gives up for good when re-registering fails.
      const pending = this.timers.get(serviceId);
      if (pending) clearTimeout(pending);
      this.timers.delete(serviceId);
    });

    // Whether this client is still the one the manager holds. `stopAll`, `unsubscribe` or a newer
    // connect can replace it during any await below; carrying on would open a socket nothing tracks —
    // the receiver's `connect()` builds a fresh one even after `destroy()` — and deliver into a
    // window that may no longer exist. The duplicate-notification bug of decisions #54, by another
    // road.
    const superseded = () => this.clients.get(serviceId) !== client;
    const giveUp = () => {
      try {
        client.destroy();
      } catch {
        // Already gone, which is the state we want.
      }
      return new Error(`push: ${serviceId} was stopped while connecting`);
    };

    let credentials: PushTypes.Credentials;
    try {
      credentials = await client.registerIfNeeded();
    } catch (error) {
      // Registration failed — a bad Firebase project, a revoked key, no network. Leaving the
      // client in the map means a dead object still driving the reconnect loop through its
      // ON_DISCONNECT handler.
      this.teardown(serviceId);
      throw error;
    }
    // The service may have been removed during those awaits.
    if (this.abandoned.has(serviceId)) {
      this.teardown(serviceId);
      throw new Error(`push: ${serviceId} was removed while registering`);
    }
    if (superseded()) throw giveUp();
    this.persist({ serviceId, vapidKey, credentials, seenIds: registration.seenIds });
    await client.connect();
    if (superseded()) throw giveUp();
    this.deps.log(`push: connected for ${serviceId}`);
    return credentials;
  }

  private onMessage(serviceId: string, vapidKey: string, envelope: PushTypes.MessageEnvelope): void {
    const current = this.current(serviceId, vapidKey);
    const { fresh, seen } = dedupePersistentIds(current.seenIds, envelope.persistentId);
    if (!fresh) return;
    this.persist({ ...current, seenIds: seen });
    this.deps.deliver(serviceId, envelope.message);
  }

  private scheduleReconnect(serviceId: string, vapidKey: string): void {
    // Not once push is off or the service is gone. A retry already in flight when `stopAll` ran
    // gives up at its next await — and its failure landed here, which armed a fresh timer, and that
    // timer opened a socket nothing tracked: pushes with push switched off, or every one twice
    // after the window was closed and reopened.
    if (!this.started || this.abandoned.has(serviceId)) return;
    if (this.timers.has(serviceId)) return;
    const attempt = this.attempts.get(serviceId) ?? 0;
    this.attempts.set(serviceId, attempt + 1);
    const delay = reconnectDelayMs(attempt);
    this.deps.log(`push: ${serviceId} disconnected, retrying in ${Math.round(delay / 1000)}s`);
    const timer = setTimeout(() => {
      this.timers.delete(serviceId);
      if (!this.started || this.abandoned.has(serviceId)) return;
      const registration = this.current(serviceId, vapidKey);
      void this.connect(registration).catch((error) => {
        this.deps.log(`push: retry failed for ${serviceId}: ${String(error)}`);
        this.scheduleReconnect(serviceId, vapidKey);
      });
    }, delay);
    // Don't hold the event loop open purely to retry a push socket.
    timer.unref?.();
    this.timers.set(serviceId, timer);
  }

  private current(serviceId: string, vapidKey: string): StoredRegistration {
    return (
      findRegistration(this.registrations, serviceId, vapidKey) ?? {
        serviceId,
        vapidKey,
        credentials: null,
        seenIds: [],
      }
    );
  }

  private persist(registration: StoredRegistration): void {
    this.registrations = upsertRegistration(this.registrations, registration);
    this.deps.save(this.registrations);
  }
}

/**
 * The library returns the same three values a browser's `PushSubscription` carries, already
 * base64url-encoded by the registration response.
 */
function toSubscription(credentials: PushTypes.Credentials): PushSubscriptionData {
  return {
    endpoint: `https://fcm.googleapis.com/fcm/send/${credentials.fcm.token}`,
    p256dh: base64Url(credentials.keys.publicKey),
    auth: base64Url(credentials.keys.authSecret),
  };
}

/** The keys come back standard-base64; the Push API expects base64url without padding. */
function base64Url(value: string): string {
  return value.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

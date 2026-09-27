// The socket lifecycle, as opposed to the policy in push.test.ts.
//
// What matters here is a wake: the TCP connections died with the network, but nothing has noticed,
// because the peer vanished without a FIN. Left alone the manager waits for a 5-minute heartbeat to
// miss and then backs off up to 5 minutes more, which is a ten-minute hole in notifications whose
// only symptom is messages arriving late.

import { describe, it, expect, beforeEach, vi } from 'vitest';

/** A stand-in for the FCM client. Records what was asked of it; opens nothing. */
class FakeReceiver {
  static instances: FakeReceiver[] = [];
  destroyed = false;
  connects = 0;
  private handlers = new Map<string, () => void>();

  constructor() {
    FakeReceiver.instances.push(this);
  }

  onCredentialsChanged(): void {}
  onNotification(): void {}
  on(event: string, handler: () => void): void {
    this.handlers.set(event, handler);
  }
  emit(event: string): void {
    this.handlers.get(event)?.();
  }
  async registerIfNeeded(): Promise<unknown> {
    return { token: 't' };
  }
  async connect(): Promise<void> {
    this.connects++;
  }
  destroy(): void {
    this.destroyed = true;
  }
}

vi.mock('@eneris/push-receiver', () => ({ default: FakeReceiver }));

const { PushManager } = await import('@main/features/push-manager');

const FIREBASE = { projectId: 'p', appId: 'a', apiKey: 'k', messagingSenderId: 'm' };

function manager(serviceIds: string[]) {
  const registrations = serviceIds.map((serviceId) => ({
    serviceId,
    vapidKey: `key-${serviceId}`,
    credentials: { token: 'stored' },
    seenIds: [],
  }));

  return new PushManager({
    firebase: () => FIREBASE,
    load: () => registrations,
    save: () => {},
    deliver: () => {},
    log: () => {},
  });
}

/** `connect` is fire-and-forget behind two awaits, so let the microtask queue drain. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  FakeReceiver.instances = [];
  vi.useRealTimers();
});

describe('reconnecting every socket after a wake', () => {

  it('tears the old client down and dials a new one, per service', async () => {
    const push = manager(['a', 'b']);
    push.start(['a', 'b']);
    await settle();

    const [first, second] = FakeReceiver.instances;
    expect(FakeReceiver.instances).toHaveLength(2);

    push.reconnectAll();
    await settle();

    expect(first.destroyed, 'the dead socket must be closed, not leaked').toBe(true);
    expect(second.destroyed).toBe(true);
    expect(FakeReceiver.instances).toHaveLength(4);
    expect(FakeReceiver.instances[2].connects).toBe(1);
    expect(FakeReceiver.instances[3].connects).toBe(1);
  });

  it('does nothing before start — there is nothing registered to reconnect', async () => {
    const push = manager(['a']);
    push.reconnectAll();
    await settle();
    expect(FakeReceiver.instances).toHaveLength(0);
  });

  it('does nothing when no service subscribes', async () => {
    const push = manager([]);
    push.start([]);
    push.reconnectAll();
    await settle();
    expect(FakeReceiver.instances).toHaveLength(0);
  });

  it('pulls a socket already deep in its retry backoff straight back to now', async () => {
    // The case the wake handler exists for. A disconnect noticed just before the lid closed leaves
    // a retry parked minutes out; on wake the user wants it now, and they want exactly one client
    // afterwards rather than a second one appearing when the stale timer eventually fires.
    vi.useFakeTimers();
    const push = manager(['a']);
    push.start(['a']);
    await vi.advanceTimersByTimeAsync(0);

    FakeReceiver.instances[0].emit('ON_DISCONNECT');
    expect(FakeReceiver.instances, 'the retry is on a timer, not immediate').toHaveLength(1);

    push.reconnectAll();
    await vi.advanceTimersByTimeAsync(0);
    expect(FakeReceiver.instances, 'reconnect is immediate').toHaveLength(2);

    // Well past the 2s first backoff. If the pending timer had survived the teardown it would fire
    // here and open a duplicate socket delivering every notification twice.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeReceiver.instances).toHaveLength(2);
  });
});

describe('a connect that is overtaken', () => {
  it('STOPPED MID-REGISTRATION, IT OPENS NOTHING — the socket nobody would track', async () => {
    // `stopAll` ran while `registerIfNeeded` was in flight. The receiver's `connect()` builds a new
    // socket even after `destroy()`, so carrying on opened one nothing held and nothing would close.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const original = FakeReceiver.prototype.registerIfNeeded;
    FakeReceiver.prototype.registerIfNeeded = async function () {
      await gate;
      return { token: 't' };
    };
    try {
      const push = manager(['a']);
      push.start(['a']);
      await settle();
      push.stopAll();
      release();
      await settle();

      const [client] = FakeReceiver.instances;
      expect(client!.connects, 'connect() must not run on a stopped client').toBe(0);
      expect(client!.destroyed).toBe(true);
      expect(push.activeCount).toBe(0);
    } finally {
      FakeReceiver.prototype.registerIfNeeded = original;
    }
  });

  it('A DROP IS ONE RECONNECT — the receiver\'s own retry cancels ours when it lands first', async () => {
    vi.useFakeTimers();
    const push = manager(['a']);
    push.start(['a']);
    await vi.advanceTimersByTimeAsync(0);

    const [client] = FakeReceiver.instances;
    client!.emit('ON_DISCONNECT'); // ours is now on a timer
    client!.emit('ON_CONNECT'); // …and the receiver's own retry got there first

    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeReceiver.instances, 'no second client from the timer that lost').toHaveLength(1);
    expect(client!.destroyed).toBe(false);
  });
});

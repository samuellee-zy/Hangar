// Ad blocking across several sessions. The fake below fails exactly the way ghostery 2.x does —
// `ipcMain.handle` throws on a second registration, *after* the session is marked enabled and before
// its network listeners exist — so these tests reproduce the bug that was live in the log.

import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import {
  COSMETIC_CHANNELS,
  createSessionBlocking,
  type HandlerRegistry,
  type SessionBlocker,
} from '@main/platform/adblock-sessions';

class FakeIpc implements HandlerRegistry {
  handlers = new Map<string, unknown>();
  handle(channel: string, listener: unknown) {
    if (this.handlers.has(channel)) {
      throw new Error(`Attempted to register a second handler for '${channel}'`);
    }
    this.handlers.set(channel, listener);
  }
  removeHandler(channel: string) {
    this.handlers.delete(channel);
  }
}

type Ses = { name: string };

/** ghostery's ElectronBlocker, reduced to what goes wrong. */
class FakeBlocker implements SessionBlocker<Ses> {
  config = { loadCosmeticFilters: true };
  contexts = new Set<Ses>();
  /** Sessions whose network listeners were actually installed — i.e. really blocking. */
  networkBlocking = new Set<Ses>();
  constructor(private ipc: FakeIpc) {}
  isBlockingEnabled(s: Ses) {
    return this.contexts.has(s);
  }
  enableBlockingInSession(s: Ses) {
    this.contexts.add(s); // recorded as enabled first, as ghostery does
    for (const channel of COSMETIC_CHANNELS) this.ipc.handle(channel, () => {});
    this.networkBlocking.add(s); // only reached if handle() didn't throw
  }
  disableBlockingInSession(s: Ses) {
    this.contexts.delete(s);
    this.networkBlocking.delete(s);
    for (const channel of COSMETIC_CHANNELS) this.ipc.removeHandler(channel);
  }
  onInjectCosmeticFilters = () => {};
  onIsMutationObserverEnabled = () => {};
}

const setup = () => {
  const ipc = new FakeIpc();
  return { ipc, blocker: new FakeBlocker(ipc), sessions: createSessionBlocking<Ses>(ipc) };
};

describe('the bug, reproduced against the fake', () => {
  it('calling ghostery directly for a second session throws and leaves it unblocked', () => {
    const { blocker } = setup();
    const google = { name: 'google' };
    const slack = { name: 'slack' };
    blocker.enableBlockingInSession(google);
    assert.throws(() => blocker.enableBlockingInSession(slack), /second handler/);
    assert.equal(blocker.isBlockingEnabled(slack), true, 'marked enabled…');
    assert.equal(blocker.networkBlocking.has(slack), false, '…and not blocking anything');
  });
});

describe('many sessions, one engine', () => {
  it('EVERY SESSION IS REALLY BLOCKING — not just the first', () => {
    const { blocker, sessions } = setup();
    const all = [{ name: 'google' }, { name: 'slack' }, { name: 'microsoft' }];
    for (const s of all) sessions.enable(blocker, s);
    for (const s of all) assert.equal(blocker.networkBlocking.has(s), true, s.name);
    assert.equal(sessions.count(), 3);
  });

  it('DISABLING ONE LEAVES COSMETIC FILTERING FOR THE OTHERS — ghostery removed it for everyone', () => {
    const { ipc, blocker, sessions } = setup();
    const google = { name: 'google' };
    const slack = { name: 'slack' };
    sessions.enable(blocker, google);
    sessions.enable(blocker, slack);

    sessions.disable(blocker, google);
    for (const channel of COSMETIC_CHANNELS) assert.ok(ipc.handlers.has(channel), channel);
    assert.equal(blocker.networkBlocking.has(slack), true);
  });

  it('disabling the last one leaves no handlers behind', () => {
    const { ipc, blocker, sessions } = setup();
    const google = { name: 'google' };
    sessions.enable(blocker, google);
    sessions.disable(blocker, google);
    assert.equal(ipc.handlers.size, 0);
    assert.equal(sessions.count(), 0);
  });

  it('enabling twice and disabling twice are both harmless', () => {
    const { blocker, sessions } = setup();
    const google = { name: 'google' };
    sessions.enable(blocker, google);
    sessions.enable(blocker, google);
    assert.equal(sessions.count(), 1);
    sessions.disable(blocker, google);
    sessions.disable(blocker, google);
    assert.equal(sessions.count(), 0);
  });

  it('a session re-enabled after being turned off blocks again', () => {
    const { blocker, sessions } = setup();
    const google = { name: 'google' };
    const slack = { name: 'slack' };
    sessions.enable(blocker, google);
    sessions.enable(blocker, slack);
    sessions.disable(blocker, slack);
    sessions.enable(blocker, slack);
    assert.equal(blocker.networkBlocking.has(slack), true);
    assert.equal(blocker.networkBlocking.has(google), true);
  });
});

// ConfigSync's lifecycle: what happens to a reconcile when the window it belongs to goes away.
//
// ⌘W on the last pane destroys the window and `dispose()` clears the shell reference; a dock click
// then builds a *second* AppWindow with a *second* ConfigSync, pointed at the same repository. That
// makes two questions load-bearing, and neither had an answer:
//
//   1. Does the first instance stop? Its 5-second debounce is `unref()`d, which keeps it from
//      holding the process open and does nothing to stop it firing. `onApplied` closes over the
//      dead window and calls `restoreLayout()` and `relayout()` on it.
//   2. Can the two run git at once? The mutex was `this.running` — correct within one instance and
//      absent across two, which is precisely the `index.lock` fight the single-`reconcile()` design
//      exists to prevent.
//
// Hermetic: a real temp git repo, stubbed `fetch`, no network.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigSync, type SyncDeps } from '@main/features/sync';
import { serialise } from '@core/config/sync';
import { DEFAULT_PREFERENCES } from '@core/config/preferences';
import type { Config } from '@shared/types';

let scratch: string;
let repo: string;
/** A directory that exists and is *not* a git repo. See `describe('dispose cancels the debounce')`. */
let notARepo: string;

function config(): Config {
  return {
    version: 4,
    preferences: { ...DEFAULT_PREFERENCES, sync: { repoPath: repo, allowPublicRepo: true } },
    accounts: [{ id: 'a1', label: 'Google', provider: 'google', partition: 'persist:grp-google' }],
    services: [],
    workspaces: [{ id: 'w', name: 'All', items: [] }],
    activeWorkspaceId: 'w',
    layouts: {},
    pushRegistrations: [],
    window: { x: 0, y: 0, width: 1440, height: 900 },
  } as unknown as Config;
}

function makeSync(over: Partial<SyncDeps> = {}) {
  const current = config();
  return new ConfigSync({
    repoPath: () => repo,
    allowPublicRepo: () => true,
    read: () => current,
    write: () => {},
    readBase: () => null,
    writeBase: () => {},
    onApplied: () => {},
    onStatusChange: () => {},
    log: () => {},
    ...over,
  });
}

beforeEach((ctx) => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'hangar-lifecycle-'));
  repo = path.join(scratch, 'clone');
  notARepo = path.join(scratch, 'plain');
  fs.mkdirSync(notARepo);
  try {
    execFileSync('git', ['init', '-q', repo]);
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo });
  } catch (err) {
    // A sandboxed shell denies `.git/hooks`, so `git init` fails for a reason that has nothing to
    // do with this code. Skip and say why rather than reporting a regression that isn't one.
    ctx.skip(`git is unusable here: ${err instanceof Error ? err.message : String(err)}`);
  }
  // No origin on the temp repo, so `probeVisibility` returns null and never reaches the network.
  // Stubbed anyway, so a regression that *does* reach for it fails loudly.
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new Error('a test made a network request');
    })
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  fs.rmSync(scratch, { recursive: true, force: true });
});

describe('dispose cancels the debounce', () => {
  // Pointed at a directory that is not a repo, so `ready()` reports `unavailable` and returns
  // before spawning anything. That keeps these on fake timers: advancing fake time flushes
  // microtasks but cannot make a real `git` subprocess finish, so a reconcile that shells out
  // would never complete inside the advance and every assertion here would be vacuous.
  const debounced = (over: Partial<SyncDeps> = {}) =>
    makeSync({ repoPath: () => notARepo, ...over });

  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('A DISPOSED INSTANCE DOES NOT RECONCILE when its armed timer fires', async () => {
    // The bug: `dispose()` dropped the `onConfigSaved` hook, which only stops *new* schedules.
    // A timer armed seconds earlier still fired, into callbacks holding a destroyed window.
    const onStatusChange = vi.fn();
    const sync = debounced({ onStatusChange });

    sync.schedule();
    sync.dispose();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(onStatusChange).not.toHaveBeenCalled();
  });

  it('the same timer DOES fire when the instance is still alive', async () => {
    // Otherwise the test above passes because scheduling is broken, not because dispose works.
    const onStatusChange = vi.fn();
    const sync = debounced({ onStatusChange });

    sync.schedule();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(onStatusChange).toHaveBeenCalled();
  });

  it('schedule() after dispose arms nothing', async () => {
    const onStatusChange = vi.fn();
    const sync = debounced({ onStatusChange });

    sync.dispose();
    sync.schedule();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(onStatusChange).not.toHaveBeenCalled();
  });

  it('reconcile() called directly on a disposed instance is a no-op', async () => {
    const onStatusChange = vi.fn();
    const sync = debounced({ onStatusChange });

    sync.dispose();
    await sync.reconcile();

    expect(onStatusChange).not.toHaveBeenCalled();
  });

  it('dispose is idempotent', () => {
    const sync = debounced();
    sync.dispose();
    expect(() => sync.dispose()).not.toThrow();
  });
});

describe('two instances share one git', () => {
  it('THE MUTEX SPANS INSTANCES, so ⌘W-then-reopen cannot race index.lock', async () => {
    // Counts overlap, not calls.
    //
    // The bracket has to span an actual await or it proves nothing: a probe that releases on the
    // next microtask never sees two passes at once even with the mutex removed, because they take
    // turns at every `await` anyway. `read()` and `onStatusChange()` bracket the decision half of
    // `once()` — between them sit `git add`, `git commit` and `git push`, which is precisely the
    // stretch where two processes fight over `index.lock`.
    let active = 0;
    let concurrent = 0;
    const enter = () => {
      active++;
      concurrent = Math.max(concurrent, active);
      return config();
    };
    const leave = () => {
      if (active > 0) active--;
    };

    const first = makeSync({ read: enter, onStatusChange: leave });
    const second = makeSync({ read: enter, onStatusChange: leave });

    await Promise.all([first.reconcile(), second.reconcile()]);

    expect(concurrent).toBeGreaterThan(0); // the probe ran at all
    expect(concurrent).toBe(1);
  });

  it('both instances still get their pass — serialised, not dropped', async () => {
    const a = vi.fn();
    const b = vi.fn();

    await Promise.all([
      makeSync({ onStatusChange: a }).reconcile(),
      makeSync({ onStatusChange: b }).reconcile(),
    ]);

    expect(a).toHaveBeenCalled();
    expect(b).toHaveBeenCalled();
  });

  it('a pass that throws does not wedge the queue for everyone after it', async () => {
    // The chain is extended with both settlement paths swallowed for exactly this reason: one
    // rejected pass must not stop config sync for the rest of the process.
    const exploding = makeSync({
      read: () => {
        throw new Error('boom');
      },
    });
    await exploding.reconcile().catch(() => {});

    const onStatusChange = vi.fn();
    await makeSync({ onStatusChange }).reconcile();

    expect(onStatusChange).toHaveBeenCalled();
  });

  it('a disposed instance releases its place rather than blocking the live one', async () => {
    const dead = makeSync();
    dead.dispose();

    const onStatusChange = vi.fn();
    await Promise.all([dead.reconcile(), makeSync({ onStatusChange }).reconcile()]);

    expect(onStatusChange).toHaveBeenCalled();
  });
});

describe('an incoming config is not applied to a dead window', () => {
  it('dispose mid-pass stops the write and the rebuild', async () => {
    // `once()` is only entered while live, but every git call inside it is an await — so the window
    // can go away halfway through. Landing a config then would write against a stale read and call
    // `onApplied` on a destroyed window.
    const write = vi.fn();
    const onApplied = vi.fn();

    const sync = makeSync({
      write,
      onApplied,
      // Disposing from inside `read()` puts the teardown exactly where the real race is: after the
      // pass has started and before it decides anything.
      read: () => {
        sync.dispose();
        return config();
      },
    });

    await sync.reconcile();

    expect(write).not.toHaveBeenCalled();
    expect(onApplied).not.toHaveBeenCalled();
  });
});

describe('what schedules a pass', () => {
  it('A WRITE THAT CHANGES NOTHING THAT TRAVELS SCHEDULES NOTHING — a window move was a git fetch', async () => {
    vi.useFakeTimers();
    try {
      let current = config();
      const reconcile = vi.fn();
      const sync = makeSync({ read: () => current });
      (sync as unknown as { reconcile: () => Promise<unknown> }).reconcile = async () => {
        reconcile();
        return sync.current();
      };
      // What the last pass saw: this config, against this repo.
      const seen = sync as unknown as { lastLocal: string; lastTarget: string; target: () => string };
      seen.lastLocal = serialise(current);
      seen.lastTarget = seen.target();

      // Machine-local: the window bounds don't travel.
      current = { ...current, window: { x: 10, y: 10, width: 1200, height: 800 } };
      sync.schedule();
      await vi.advanceTimersByTimeAsync(6_000);
      expect(reconcile).not.toHaveBeenCalled();

      // A service does.
      current = { ...current, workspaces: [{ id: 'w', name: 'Renamed', items: [] }] };
      sync.schedule();
      await vi.advanceTimersByTimeAsync(6_000);
      expect(reconcile).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('A NEW REPO IS A CHANGE — though the repo path is machine-local and never travels', async () => {
    vi.useFakeTimers();
    try {
      const current = config();
      let target = repo;
      const reconcile = vi.fn();
      const sync = makeSync({ read: () => current, repoPath: () => target });
      (sync as unknown as { reconcile: () => Promise<unknown> }).reconcile = async () => {
        reconcile();
        return sync.current();
      };
      // The last pass: this config, against this repo.
      const seen = sync as unknown as { lastLocal: string; lastTarget: string; target: () => string };
      seen.lastLocal = serialise(current);
      seen.lastTarget = seen.target();

      target = path.join(scratch, 'another');
      sync.schedule();
      await vi.advanceTimersByTimeAsync(6_000);
      expect(reconcile, 'it waited for the five-minute poll').toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

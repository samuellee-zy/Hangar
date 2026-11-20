import { afterEach, describe, expect, it, vi } from 'vitest';
import { servicesToHibernate } from '../../src/core/runtime/hibernate';
import { setPreference, withDefaults } from '../../src/core/config/preferences';
import { LoadQueue } from '../../src/main/features/load-queue';
import { IdleRelease } from '../../src/main/features/idle-release';

afterEach(() => vi.useRealTimers());
const now = 1_000_000;
const candidate = (serviceId: string, age: number, extra = {}) => ({ serviceId, visible: false, sleeping: false,
  busy: false, hibernate: true, lastActiveAt: now - age, ...extra });

describe('bounded background retention', () => {
  it('evicts oldest eligible pages, without counting protected services against the cache', () => {
    const pages = [candidate('old', 180_000), candidate('recent', 90_000), candidate('new', 10_000),
      candidate('call', 200_000, { busy: true }), candidate('pane', 200_000, { visible: true }),
      candidate('essential', 200_000, { hibernate: false })];
    expect(servicesToHibernate(pages, 5, now, 2)).toEqual(['old']);
    expect(servicesToHibernate(pages, 5, now, 1)).toEqual(['old', 'recent']);
    expect(servicesToHibernate(pages, 0, now, 1)).toEqual([]);
  });
  it('honours the idle deadline with an unlimited cache, and a minimum minute under a tight cap', () => {
    const pages = [candidate('old', 300_000), candidate('new', 50_000), candidate('newer', 10_000)];
    expect(servicesToHibernate(pages, 5, now, 0)).toEqual(['old']);
    expect(servicesToHibernate(pages, 5, now, 1)).toEqual(['old']);
  });
  it('loads legacy settings without changing their retention and rejects malformed limits', () => {
    const prefs = withDefaults({ behaviour: { hibernateAfterMinutes: 30 } });
    expect(prefs.behaviour.maxCachedServices).toBe(0);
    for (const value of [-1, 0.5, Infinity, NaN, '2', null]) expect(setPreference(prefs, 'behaviour.maxCachedServices', value)).toBe(false);
    expect(setPreference(prefs, 'behaviour.maxCachedServices', 2)).toBe(true);
  });
});

describe('background navigation queue', () => {
  it('holds a slot until the aborted navigation has stopped, then leaves a gap', async () => {
    vi.useFakeTimers();
    const queue = new LoadQueue(1000, 20_000), events: string[] = [];
    queue.add({ id: 'hung', run: (signal) => new Promise((resolve) => {
      events.push('start');
      signal.addEventListener('abort', () => { events.push('stop'); resolve(); });
    }) });
    queue.add({ id: 'next', run: async () => { events.push('next'); } });
    await vi.advanceTimersByTimeAsync(20_999);
    expect(events).toEqual(['start']);
    await vi.advanceTimersByTimeAsync(1);
    expect(events).toEqual(['start', 'stop']);
    await vi.advanceTimersByTimeAsync(999);
    expect(events).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(events).toEqual(['start', 'stop', 'next']);
    queue.dispose();
  });
  it('deduplicates, cancels queued jobs, and never starts work after disposal', async () => {
    vi.useFakeTimers();
    const queue = new LoadQueue(), run = vi.fn(async () => {});
    queue.add({ id: 'one', run }); queue.add({ id: 'one', run });
    queue.add({ id: 'two', run }); queue.cancel('two');
    await vi.advanceTimersByTimeAsync(2000);
    expect(run).toHaveBeenCalledTimes(1);
    queue.add({ id: 'three', run }); queue.dispose();
    await vi.runAllTimersAsync();
    expect(run).toHaveBeenCalledTimes(1);
  });
});

it('repeated layout passes do not postpone release; reuse cancels the old deadline', () => {
  vi.useFakeTimers();
  const release = vi.fn(), idle = new IdleRelease(release);
  idle.arm(); vi.advanceTimersByTime(30_000); idle.arm(); vi.advanceTimersByTime(30_000);
  expect(release).toHaveBeenCalledTimes(1);
  idle.arm(); vi.advanceTimersByTime(30_000); idle.cancel(); vi.advanceTimersByTime(60_000);
  expect(release).toHaveBeenCalledTimes(1);
});

it('promoting an active load does not abort it; clearing allows the same service to be queued again', async () => {
  vi.useFakeTimers();
  const queue = new LoadQueue(100), events: string[] = [];
  queue.add({ id: 'one', run: (signal) => new Promise((resolve) => {
    signal.addEventListener('abort', () => { events.push('aborted'); resolve(); });
  }) });
  await vi.advanceTimersByTimeAsync(100);
  queue.cancel('one', false);
  expect(events).toEqual([]);
  queue.clear();
  queue.add({ id: 'one', run: async () => { events.push('restarted'); } });
  await vi.advanceTimersByTimeAsync(200);
  expect(events).toEqual(['aborted', 'restarted']);
  queue.dispose();
});

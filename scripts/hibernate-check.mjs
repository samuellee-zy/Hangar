// Hibernation decides what to unload. The failure mode that matters isn't wasting memory — it's
// unloading something the user is looking at, which is instant and obvious data loss in a form.
// So the "never sleep a visible service" rule gets pinned hardest.
//
// Run: npm run check:hibernate

import assert from 'node:assert/strict';
import { servicesToHibernate, servicesToRefresh } from '../out-check/hibernate.mjs';

let checks = 0;
const ok = (label, fn) => {
  fn();
  checks++;
  console.log(`  ✓ ${label}`);
};

const NOW = 1_000_000_000;
const minutesAgo = (n) => NOW - n * 60_000;

const svc = (id, over = {}) => ({
  serviceId: id,
  visible: false,
  sleeping: false,
  hibernate: true,
  lastActiveAt: minutesAgo(60),
  ...over,
});

console.log('what gets slept');

ok('an idle background service past the timeout is slept', () => {
  assert.deepEqual(servicesToHibernate([svc('a')], 30, NOW), ['a']);
});

ok('a VISIBLE service is never slept, however idle it looks', () => {
  // The catastrophic case: unloading a pane the user is typing into.
  assert.deepEqual(
    servicesToHibernate([svc('a', { visible: true, lastActiveAt: minutesAgo(600) })], 5, NOW),
    []
  );
});

ok('a service that opted out is never slept', () => {
  assert.deepEqual(servicesToHibernate([svc('a', { hibernate: false })], 5, NOW), []);
});

ok('an already-sleeping service is not slept twice', () => {
  assert.deepEqual(servicesToHibernate([svc('a', { sleeping: true })], 5, NOW), []);
});

ok('a timeout of 0 disables hibernation entirely — that is the off switch', () => {
  assert.deepEqual(servicesToHibernate([svc('a')], 0, NOW), []);
  assert.deepEqual(servicesToHibernate([svc('a')], -1, NOW), []);
});

ok('a service idle for less than the timeout is left alone', () => {
  assert.deepEqual(servicesToHibernate([svc('a', { lastActiveAt: minutesAgo(4) })], 5, NOW), []);
});

ok('the boundary is inclusive, so a timeout of N actually fires at N', () => {
  assert.deepEqual(servicesToHibernate([svc('a', { lastActiveAt: minutesAgo(5) })], 5, NOW), ['a']);
});

ok('only the eligible subset is returned from a mixed set', () => {
  const result = servicesToHibernate(
    [
      svc('idle'),
      svc('onscreen', { visible: true }),
      svc('optedout', { hibernate: false }),
      svc('recent', { lastActiveAt: minutesAgo(1) }),
      svc('asleep', { sleeping: true }),
    ],
    30,
    NOW
  );
  assert.deepEqual(result, ['idle']);
});

console.log('what gets refreshed after a wake');

ok('a short suspend refreshes nothing — waking from a two-minute nap should be seamless', () => {
  const items = [{ serviceId: 'a', sleeping: false, visible: true, lastActiveAt: NOW }];
  assert.deepEqual(servicesToRefresh(items, 60_000), []);
});

ok('a long suspend refreshes loaded views, visible ones first', () => {
  const items = [
    { serviceId: 'background', sleeping: false, visible: false, lastActiveAt: NOW },
    { serviceId: 'onscreen', sleeping: false, visible: true, lastActiveAt: NOW },
  ];
  assert.deepEqual(servicesToRefresh(items, 30 * 60_000), ['onscreen', 'background']);
});

ok('sleeping services are not woken just to refresh them', () => {
  const items = [{ serviceId: 'a', sleeping: true, visible: false, lastActiveAt: NOW }];
  assert.deepEqual(servicesToRefresh(items, 30 * 60_000), []);
});

console.log(`\n${checks} checks passed`);

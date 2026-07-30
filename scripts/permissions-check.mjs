// Permission policy. Before this every service got an identical grant, which meant a custom
// connection to an arbitrary URL could take the microphone and camera on request with no prompt.
// The catalog is curated; "add any website by URL" is not.
//
// Run: npm run check:permissions

import assert from 'node:assert/strict';
import { decidePermission, findOrphanPartitions } from '../out-check/permissions.mjs';

let checks = 0;
const ok = (label, fn) => {
  fn();
  checks++;
  console.log(`  ✓ ${label}`);
};

const ask = (permission, over = {}) =>
  decidePermission({ permission, isCatalogService: true, allowMedia: false, ...over });

console.log('baseline, granted to anything');

ok('notifications, fullscreen, sanitized clipboard write and pointer lock are allowed', () => {
  for (const p of ['notifications', 'fullscreen', 'clipboard-sanitized-write', 'pointerLock']) {
    assert.equal(ask(p, { isCatalogService: false }), true, `${p} should be allowed`);
  }
});

console.log('provenance');

ok('a curated catalog service gets media, clipboard read and screen share', () => {
  for (const p of ['media', 'clipboard-read', 'display-capture']) {
    assert.equal(ask(p), true, `${p} should be allowed for a catalog service`);
  }
});

ok('A CUSTOM CONNECTION IS DENIED MIC AND CAMERA BY DEFAULT', () => {
  assert.equal(ask('media', { isCatalogService: false }), false);
  assert.equal(ask('display-capture', { isCatalogService: false }), false);
  assert.equal(ask('clipboard-read', { isCatalogService: false }), false);
});

ok('a custom connection can be granted media explicitly, per service', () => {
  assert.equal(ask('media', { isCatalogService: false, allowMedia: true }), true);
});

ok('allowMedia does not widen the baseline for a catalog service either way', () => {
  assert.equal(ask('geolocation', { allowMedia: true }), false);
});

console.log('deny by default');

ok('hardware and location permissions are refused for everyone', () => {
  for (const p of ['geolocation', 'hid', 'serial', 'usb', 'midi', 'idle-detection', 'bluetooth']) {
    assert.equal(ask(p), false, `${p} must be denied`);
    assert.equal(ask(p, { isCatalogService: false, allowMedia: true }), false);
  }
});

ok('an unknown permission Electron adds later arrives denied, not granted', () => {
  // The whole point of an allowlist: new permission types are refused until reviewed.
  assert.equal(ask('some-future-capability'), false);
});

console.log('orphan partitions');

ok('directories with no account pointing at them are reported', () => {
  const orphans = findOrphanPartitions(
    ['persist:grp-gmail', 'persist:acct-1'],
    ['grp-gmail', 'acct-1', 'acct-stale', 'grp-gone']
  );
  assert.deepEqual(orphans, ['acct-stale', 'grp-gone']);
});

ok('the persist: prefix is stripped before comparing — otherwise everything looks orphaned', () => {
  assert.deepEqual(findOrphanPartitions(['persist:grp-gmail'], ['grp-gmail']), []);
});

ok('no accounts means every directory is orphaned, and none when the disk is empty', () => {
  assert.deepEqual(findOrphanPartitions([], ['a', 'b']), ['a', 'b']);
  assert.deepEqual(findOrphanPartitions(['persist:a'], []), []);
});

console.log(`\n${checks} checks passed`);

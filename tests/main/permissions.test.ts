// Permission policy. Before this every service got an identical grant, which meant a custom
// connection to an arbitrary URL could take the microphone and camera on request with no prompt.
// The catalog is curated; "add any website by URL" is not.
//

import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { decidePermission, findOrphanPartitions } from '@core/runtime/permissions';


const ask = (permission, over = {}) =>
  decidePermission({ permission, fromService: true, isCatalogService: true, allowMedia: false, ...over });

describe("baseline, granted to anything", () => {

  it('notifications, fullscreen, sanitized clipboard write and pointer lock are allowed', () => {
    for (const p of ['notifications', 'fullscreen', 'clipboard-sanitized-write', 'pointerLock']) {
      assert.equal(ask(p, { isCatalogService: false }), true, `${p} should be allowed`);
    }
  });
});

describe('the requesting frame', () => {

  it('AN IFRAME FROM ANOTHER ORIGIN GETS NO HARDWARE, CLIPBOARD OR NOTIFICATIONS — even inside a catalog service', () => {
    // The partition's handler used to answer for the service whatever frame asked: an ad or an
    // embed inside Slack got the camera because Slack is in the catalog.
    for (const p of ['media', 'display-capture', 'clipboard-read', 'notifications']) {
      assert.equal(ask(p, { fromService: false }), false, `${p} from a third-party frame`);
      assert.equal(ask(p, { fromService: false, allowMedia: true }), false, `${p}, even with allowMedia`);
    }
  });

  it('an embed may still go fullscreen, lock the pointer and write to the clipboard', () => {
    for (const p of ['fullscreen', 'pointerLock', 'clipboard-sanitized-write']) {
      assert.equal(ask(p, { fromService: false, isCatalogService: false }), true, p);
    }
  });
});

describe("provenance", () => {

  it('a curated catalog service gets media, clipboard read and screen share', () => {
    for (const p of ['media', 'clipboard-read', 'display-capture']) {
      assert.equal(ask(p), true, `${p} should be allowed for a catalog service`);
    }
  });

  it('A CUSTOM CONNECTION IS DENIED MIC AND CAMERA BY DEFAULT', () => {
    assert.equal(ask('media', { isCatalogService: false }), false);
    assert.equal(ask('display-capture', { isCatalogService: false }), false);
    assert.equal(ask('clipboard-read', { isCatalogService: false }), false);
  });

  it('a custom connection can be granted media explicitly, per service', () => {
    assert.equal(ask('media', { isCatalogService: false, allowMedia: true }), true);
  });

  it('allowMedia does not widen the baseline for a catalog service either way', () => {
    assert.equal(ask('geolocation', { allowMedia: true }), false);
  });
});

describe("deny by default", () => {

  it('hardware and location permissions are refused for everyone', () => {
    for (const p of ['geolocation', 'hid', 'serial', 'usb', 'midi', 'idle-detection', 'bluetooth']) {
      assert.equal(ask(p), false, `${p} must be denied`);
      assert.equal(ask(p, { isCatalogService: false, allowMedia: true }), false);
    }
  });

  it('an unknown permission Electron adds later arrives denied, not granted', () => {
    // The whole point of an allowlist: new permission types are refused until reviewed.
    assert.equal(ask('some-future-capability'), false);
  });
});

describe("orphan partitions", () => {

  it('directories with no account pointing at them are reported', () => {
    const orphans = findOrphanPartitions(
      ['persist:grp-gmail', 'persist:acct-1'],
      ['grp-gmail', 'acct-1', 'acct-stale', 'grp-gone']
    );
    assert.deepEqual(orphans, ['acct-stale', 'grp-gone']);
  });

  it('the persist: prefix is stripped before comparing — otherwise everything looks orphaned', () => {
    assert.deepEqual(findOrphanPartitions(['persist:grp-gmail'], ['grp-gmail']), []);
  });

  it('no accounts means every directory is orphaned, and none when the disk is empty', () => {
    assert.deepEqual(findOrphanPartitions([], ['a', 'b']), ['a', 'b']);
    assert.deepEqual(findOrphanPartitions(['persist:a'], []), []);
  });
});

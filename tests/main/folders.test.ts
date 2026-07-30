// The rail tree has two invariants that break silently if violated: a service appears exactly
// once, and folders never nest. A duplicate tile or a service that vanishes into a deleted folder
// is the kind of bug you only notice days later, so pin them here.
//

import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import {
  createFolder,
  deleteFolder,
  findFolder,
  flattenServiceIds,
  migrateWorkspaceV3,
  moveToFolder,
  pruneMissing,
  reorderItems,
} from '../../src/main/folders';


const ws = (...ids) => ({
  id: 'w',
  name: 'W',
  items: ids.map((id) => ({ kind: 'service', id })),
});

/** Every service id anywhere in the tree, for duplicate detection. */
const allIds = (w) => [
  ...w.items.filter((i) => i.kind === 'service').map((i) => i.id),
  ...w.items.filter((i) => i.kind === 'folder').flatMap((i) => i.serviceIds),
];

describe("v3 → v4 migration", () => {

  it('a flat serviceIds array becomes ordered service items', () => {
    const w = migrateWorkspaceV3({ id: 'w', name: 'W', serviceIds: ['a', 'b', 'c'] });
    assert.deepEqual(flattenServiceIds(w), ['a', 'b', 'c'], 'order preserved');
    assert.ok(w.items.every((i) => i.kind === 'service'));
  });

  it('an already-migrated workspace is left alone', () => {
    const items = [{ kind: 'folder', id: 'f', name: 'F', collapsed: false, serviceIds: ['a'] }];
    assert.deepEqual(migrateWorkspaceV3({ id: 'w', name: 'W', items }).items, items);
  });
});

describe("folder operations", () => {

  it('creating a folder from services removes them from the top level — no duplicates', () => {
    const w = ws('a', 'b', 'c');
    createFolder(w, 'Work', ['a', 'c']);
    assert.deepEqual(allIds(w).sort(), ['a', 'b', 'c'], 'each service still appears exactly once');
    assert.deepEqual(flattenServiceIds(w), ['b', 'a', 'c']);
  });

  it('moving between folders detaches first, so a service is never in two places', () => {
    const w = ws('a', 'b');
    const f1 = createFolder(w, 'One');
    const f2 = createFolder(w, 'Two');
    moveToFolder(w, 'a', f1);
    moveToFolder(w, 'a', f2);
    assert.deepEqual(allIds(w).sort(), ['a', 'b']);
    assert.deepEqual(findFolder(w, f1).serviceIds, []);
    assert.deepEqual(findFolder(w, f2).serviceIds, ['a']);
  });

  it('moving to null returns a service to the top level', () => {
    const w = ws('a');
    const f = createFolder(w, 'F', ['a']);
    moveToFolder(w, 'a', null);
    assert.deepEqual(findFolder(w, f).serviceIds, []);
    assert.deepEqual(flattenServiceIds(w), ['a']);
  });

  it('moving to an unknown folder puts the service at the top level rather than losing it', () => {
    const w = ws('a');
    moveToFolder(w, 'a', 'does-not-exist');
    assert.deepEqual(flattenServiceIds(w), ['a']);
  });

  it('moving an unknown service is a no-op, not a phantom tile', () => {
    const w = ws('a');
    moveToFolder(w, 'ghost', null);
    assert.deepEqual(flattenServiceIds(w), ['a']);
  });

  it('deleting a folder promotes its services in place rather than deleting them', () => {
    const w = ws('a', 'b', 'c');
    const f = createFolder(w, 'F', ['a', 'b']);
    deleteFolder(w, f);
    assert.deepEqual(flattenServiceIds(w), ['c', 'a', 'b'], 'promoted where the folder sat');
    assert.equal(w.items.every((i) => i.kind === 'service'), true);
  });
});

describe("ordering and pruning", () => {

  it('reordering only touches the top level and never drops unknown items', () => {
    const w = ws('a', 'b', 'c');
    reorderItems(w, ['c', 'a']);
    assert.deepEqual(flattenServiceIds(w), ['c', 'a', 'b'], 'omitted ids are appended, not lost');
  });

  it('pruning removes deleted services from both levels', () => {
    const w = ws('a', 'b');
    const f = createFolder(w, 'F', ['b']);
    pruneMissing(w, new Set(['a']));
    assert.deepEqual(flattenServiceIds(w), ['a']);
    assert.deepEqual(findFolder(w, f).serviceIds, [], 'folder survives, its dead member does not');
  });

  it('folders never nest — a folder cannot be moved into a folder', () => {
    const w = ws('a');
    const outer = createFolder(w, 'Outer');
    const inner = createFolder(w, 'Inner');
    // moveToFolder only accepts service ids; a folder id simply isn't found.
    moveToFolder(w, inner, outer);
    assert.equal(findFolder(w, outer).serviceIds.length, 0);
    assert.ok(findFolder(w, inner), 'the inner folder is still a top-level item');
  });
});

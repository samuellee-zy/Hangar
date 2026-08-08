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
  moveItemTo,
  moveToFolder,
  pruneMissing,
} from '@core/workspace/folders';


const ws = (...ids) => ({
  id: 'w',
  name: 'W',
  items: ids.map((id) => ({ kind: 'service' as const, id })),
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
    const items = [{ kind: 'folder' as const, id: 'f', name: 'F', collapsed: false, serviceIds: ['a'] }];
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
    assert.deepEqual(findFolder(w, f1)!.serviceIds, []);
    assert.deepEqual(findFolder(w, f2)!.serviceIds, ['a']);
  });

  it('moving to null returns a service to the top level', () => {
    const w = ws('a');
    const f = createFolder(w, 'F', ['a']);
    moveToFolder(w, 'a', null);
    assert.deepEqual(findFolder(w, f)!.serviceIds, []);
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

  it('pruning removes deleted services from both levels', () => {
    const w = ws('a', 'b');
    const f = createFolder(w, 'F', ['b']);
    pruneMissing(w, new Set(['a']));
    assert.deepEqual(flattenServiceIds(w), ['a']);
    assert.deepEqual(findFolder(w, f)!.serviceIds, [], 'folder survives, its dead member does not');
  });

  it('folders never nest — a folder cannot be moved into a folder', () => {
    const w = ws('a');
    const outer = createFolder(w, 'Outer');
    const inner = createFolder(w, 'Inner');
    // moveToFolder only accepts service ids; a folder id simply isn't found.
    moveToFolder(w, inner, outer);
    assert.equal(findFolder(w, outer)!.serviceIds.length, 0);
    assert.ok(findFolder(w, inner), 'the inner folder is still a top-level item');
  });
});

// Everything a rail drag can do arrives here as one call. What makes it worth this much coverage is
// that the *destination* is inferred: the renderer says only "a was dropped on b", and this decides
// whether that means reorder, file into a folder, or take out of one.
describe('moveItemTo', () => {

  it('reorders two top-level tiles, with dnd-kit arrayMove semantics', () => {
    // Removal happens first, so the target index lands in the already-shortened list — which is
    // what the drag animation has already shown the user. Off-by-one here looks like the drag
    // "not quite working" rather than like a bug.
    const w = ws('a', 'b', 'c', 'd');
    moveItemTo(w, 'a', 'c');
    assert.deepEqual(flattenServiceIds(w), ['b', 'c', 'a', 'd']);
  });

  it('reorders backwards too', () => {
    const w = ws('a', 'b', 'c', 'd');
    moveItemTo(w, 'd', 'b');
    assert.deepEqual(flattenServiceIds(w), ['a', 'd', 'b', 'c']);
  });

  it('DROPPED ON A FOLDER, A SERVICE GOES INTO IT', () => {
    // The gesture this whole change exists for. Until now filing into a folder was reachable only
    // from the right-click menu.
    const w = ws('a', 'b');
    const f = createFolder(w, 'Work');
    moveItemTo(w, 'a', f);
    assert.deepEqual(findFolder(w, f)!.serviceIds, ['a']);
    assert.deepEqual(allIds(w).sort(), ['a', 'b'], 'exactly once, still');
  });

  it('files into a collapsed folder just the same', () => {
    // A collapsed folder shows no members to aim between, and the gesture has to mean the same
    // thing whether the folder is open or shut.
    const w = ws('a');
    const f = createFolder(w, 'Work', []);
    findFolder(w, f)!.collapsed = true;
    moveItemTo(w, 'a', f);
    assert.deepEqual(findFolder(w, f)!.serviceIds, ['a']);
  });

  it('dropped on a member, a service joins that folder beside it', () => {
    const w = ws('a');
    const f = createFolder(w, 'Work', []);
    findFolder(w, f)!.serviceIds.push('x', 'y');
    moveItemTo(w, 'a', 'y');
    assert.deepEqual(findFolder(w, f)!.serviceIds, ['x', 'a', 'y']);
  });

  it('DROPPED ON A TOP-LEVEL TILE, A MEMBER LEAVES ITS FOLDER', () => {
    // The way back out. Without this the drag is a one-way door and the only exit is the menu.
    const w = ws('a', 'b');
    const f = createFolder(w, 'Work', ['a']);
    moveItemTo(w, 'a', 'b');
    assert.deepEqual(findFolder(w, f)!.serviceIds, []);
    assert.deepEqual(flattenServiceIds(w), ['a', 'b']);
  });

  it('reorders within a folder', () => {
    const w = ws();
    const f = createFolder(w, 'Work', []);
    findFolder(w, f)!.serviceIds.push('x', 'y', 'z');
    moveItemTo(w, 'z', 'x');
    assert.deepEqual(findFolder(w, f)!.serviceIds, ['z', 'x', 'y']);
  });

  it('moves a service straight from one folder to another', () => {
    const w = ws();
    const one = createFolder(w, 'One', []);
    const two = createFolder(w, 'Two', []);
    findFolder(w, one)!.serviceIds.push('x');
    moveItemTo(w, 'x', two);
    assert.deepEqual(findFolder(w, one)!.serviceIds, []);
    assert.deepEqual(findFolder(w, two)!.serviceIds, ['x']);
  });

  it('A FOLDER DROPPED ON A FOLDER REORDERS — IT NEVER NESTS', () => {
    // The invariant the whole module rests on, and the one this new entry point could most easily
    // break: `overId` naming a folder means "file into it" for a service and must not for a folder.
    const w = ws();
    const one = createFolder(w, 'One', []);
    const two = createFolder(w, 'Two', []);
    moveItemTo(w, two, one);
    assert.deepEqual(findFolder(w, one)!.serviceIds, []);
    assert.deepEqual(w.items.map((i) => i.id), [two, one]);
  });

  it('a folder dropped on a member lands beside that member’s folder', () => {
    const w = ws();
    const one = createFolder(w, 'One', []);
    const two = createFolder(w, 'Two', []);
    findFolder(w, one)!.serviceIds.push('x');
    moveItemTo(w, two, 'x');
    assert.deepEqual(w.items.map((i) => i.id), [two, one], 'beside the folder, not inside it');
  });

  it('a drop onto itself changes nothing', () => {
    const w = ws('a', 'b');
    moveItemTo(w, 'a', 'a');
    assert.deepEqual(flattenServiceIds(w), ['a', 'b']);
  });

  it('AN ID THE TREE HAS NEVER HEARD OF IS IGNORED, NOT GUESSED AT', () => {
    // The rail can change underneath a drag — a service removed from Settings or the context menu
    // while the pointer is down. Acting on a stale list would move something else.
    const w = ws('a', 'b');
    moveItemTo(w, 'ghost', 'b');
    moveItemTo(w, 'a', 'ghost');
    assert.deepEqual(flattenServiceIds(w), ['a', 'b']);
  });

  it('never loses or duplicates a service, whatever is dropped on whatever', () => {
    const ids = ['a', 'b', 'x', 'y'];
    for (const from of ids) {
      for (const to of ids) {
        const w = ws('a', 'b');
        const f = createFolder(w, 'Work', []);
        findFolder(w, f)!.serviceIds.push('x', 'y');
        moveItemTo(w, from, to);
        assert.deepEqual(allIds(w).sort(), ids, `${from} onto ${to}`);
      }
    }
  });
});

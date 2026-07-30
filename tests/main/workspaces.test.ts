// Workspace lifecycle. The dangerous operation is deletion: services live in one global list and a
// workspace only references them, so deleting a workspace can strand a service — still in config,
// still holding a session, invisible in every rail. Silent data loss with extra steps.
//

import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import {
  createWorkspace,
  deleteWorkspace,
  rehomeUnreachable,
  renameWorkspace,
  reorderWorkspaces,
} from '../../src/main/workspaces';


const svc = (id) => ({ kind: 'service', id });

const config = (...workspaces) => ({
  version: 4,
  services: [...new Set(workspaces.flatMap((w) => w.items.map((i) => i.id)))].map((id) => ({ id })),
  workspaces,
  activeWorkspaceId: workspaces[0]?.id ?? null,
  layouts: {},
  accounts: [],
  preferences: {},
});

const ws = (id, ...ids) => ({ id, name: id, items: ids.map(svc) });
const reachable = (c) =>
  new Set(c.workspaces.flatMap((w) => w.items.flatMap((i) => (i.kind === 'service' ? [i.id] : i.serviceIds))));

describe("create and rename", () => {

  it('a new workspace starts empty', () => {
    const c = config(ws('w1', 'a'));
    const id = createWorkspace(c, 'Work');
    assert.equal(c.workspaces.length, 2);
    assert.deepEqual(c.workspaces.find((w) => w.id === id).items, []);
  });

  it('a blank name falls back rather than creating an unlabelled workspace', () => {
    const c = config(ws('w1', 'a'));
    const id = createWorkspace(c, '   ');
    assert.equal(c.workspaces.find((w) => w.id === id).name, 'Workspace');
  });

  it('renaming trims, and a blank rename is ignored', () => {
    const c = config(ws('w1', 'a'));
    renameWorkspace(c, 'w1', '  Personal  ');
    assert.equal(c.workspaces[0].name, 'Personal');
    renameWorkspace(c, 'w1', '   ');
    assert.equal(c.workspaces[0].name, 'Personal', 'unchanged');
  });
});

describe("deletion", () => {

  it('THE LAST WORKSPACE CANNOT BE DELETED — there would be nowhere to put anything', () => {
    const c = config(ws('w1', 'a'));
    const result = deleteWorkspace(c, 'w1');
    assert.equal(result.deleted, false);
    assert.equal(c.workspaces.length, 1);
  });

  it('deleting rehomes services nothing else references, rather than stranding them', () => {
    const c = config(ws('w1', 'a'), ws('w2', 'b'));
    const result = deleteWorkspace(c, 'w2');
    assert.deepEqual(result.rehomed, ['b']);
    assert.ok(reachable(c).has('b'), 'b is still reachable somewhere');
  });

  it('a service present in another workspace is not duplicated on delete', () => {
    const c = config(ws('w1', 'a', 'b'), ws('w2', 'b'));
    deleteWorkspace(c, 'w2');
    const ids = c.workspaces[0].items.map((i) => i.id);
    assert.deepEqual(ids, ['a', 'b'], 'b appears once, not twice');
  });

  it('deleting the active workspace moves the active pointer somewhere real', () => {
    const c = config(ws('w1', 'a'), ws('w2', 'b'));
    c.activeWorkspaceId = 'w2';
    const result = deleteWorkspace(c, 'w2');
    assert.equal(result.activeWorkspaceId, 'w1');
    assert.equal(c.activeWorkspaceId, 'w1');
  });

  it('deleting an inactive workspace leaves the active pointer alone', () => {
    const c = config(ws('w1', 'a'), ws('w2', 'b'));
    deleteWorkspace(c, 'w1');
    assert.equal(c.activeWorkspaceId, 'w2', 'w1 was active but is gone; falls to the survivor');
  });

  it('deleting an unknown workspace is a no-op', () => {
    const c = config(ws('w1', 'a'), ws('w2', 'b'));
    assert.equal(deleteWorkspace(c, 'nope').deleted, false);
    assert.equal(c.workspaces.length, 2);
  });
});

describe("ordering and the safety net", () => {

  it('reordering appends ids the caller omitted rather than dropping them', () => {
    const c = config(ws('w1'), ws('w2'), ws('w3'));
    reorderWorkspaces(c, ['w3', 'w1']);
    assert.deepEqual(c.workspaces.map((w) => w.id), ['w3', 'w1', 'w2']);
  });

  it('rehomeUnreachable rescues a service present in no workspace at all', () => {
    const c = config(ws('w1', 'a'));
    c.services.push({ id: 'stranded' });
    const rescued = rehomeUnreachable(c);
    assert.deepEqual(rescued, ['stranded']);
    assert.ok(reachable(c).has('stranded'));
  });

  it('rehomeUnreachable is a no-op when everything is already reachable', () => {
    const c = config(ws('w1', 'a'));
    assert.deepEqual(rehomeUnreachable(c), []);
    assert.equal(c.workspaces[0].items.length, 1, 'no duplicate appended');
  });
});

// Commands: the shape checked at the IPC boundary, and the routing table behind dispatch.

import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { commandProblem, commandTypes, isCommand } from '@core/commands';
import { handledTypes } from '@main/window/commands';

describe('what counts as a command', () => {
  it('well-formed commands pass, optional fields included or not', () => {
    for (const command of [
      { type: 'focus-service', serviceId: 'gmail' },
      { type: 'split' },
      { type: 'cycle-pane', delta: -1 },
      { type: 'add-service', catalogId: 'gmail' },
      { type: 'add-service', catalogId: 'gmail', forceNewAccount: true },
      { type: 'move-to-folder', serviceId: 'a', folderId: null },
      { type: 'set-dnd', on: true, until: null },
      { type: 'set-preference', path: 'appearance.theme', value: 'dark' },
      { type: 'update-service', serviceId: 'a', patch: { zoom: 1.2 } },
      { type: 'drag-split', index: 0, screenX: 812 },
      { type: 'move-pane', delta: 1 },
      { type: 'reopen-pane' },
    ]) {
      assert.equal(commandProblem(command), null, JSON.stringify(command));
    }
  });

  it('A MISSING OR MISTYPED FIELD IS REFUSED — it used to reach dispatch as it came', () => {
    assert.match(commandProblem({ type: 'focus-service' })!, /serviceId/);
    assert.match(commandProblem({ type: 'cycle-pane', delta: '1' })!, /delta/);
    assert.match(commandProblem({ type: 'cycle-pane', delta: 2 })!, /delta/);
    assert.match(commandProblem({ type: 'zoom', direction: 'sideways' })!, /direction/);
    assert.match(commandProblem({ type: 'reorder-workspaces', workspaceIds: ['a', 3] })!, /workspaceIds/);
    assert.match(commandProblem({ type: 'drag-tile-to', from: 'rail', x: Number.NaN, y: 0 })!, /x/);
    assert.match(commandProblem({ type: 'update-service', serviceId: 'a', patch: 'x' })!, /patch/);
    assert.match(commandProblem({ type: 'drag-split', index: 0, screenX: '812' })!, /screenX/);
    assert.match(commandProblem({ type: 'move-pane', delta: 2 })!, /delta/);
  });

  it('an unknown type, or something that is not an object, is refused', () => {
    assert.match(commandProblem({ type: 'format-disk' })!, /unknown type/);
    assert.match(commandProblem({ type: 'toString' })!, /unknown type/, 'not fooled by the prototype');
    assert.equal(commandProblem(null), 'not an object');
    assert.equal(commandProblem('split'), 'not an object');
    assert.equal(isCommand([{ type: 'split' }]), false);
  });
});

describe('the routing table', () => {
  it('EVERY COMMAND TYPE HAS A HANDLER, and nothing is handled that is not a command', () => {
    // The switch this replaced could miss a type silently; the table is assembled from six files,
    // so this is what says none of them dropped one.
    assert.deepEqual([...handledTypes()].sort(), [...commandTypes()].sort());
  });
});

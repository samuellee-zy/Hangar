// The control socket (decision #114). Only your own user can reach it, but what it may do is still
// a short list: the last block runs hostile lines through it and checks nothing escapes that list.

import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import type { Config, ShellState } from '@shared/types';
import { commandTypes } from '@core/commands';
import { LINK_COMMAND_TYPES } from '@core/runtime/deeplink';
import {
  CONTROL_COMMAND_TYPES,
  CONTROL_SHOWS,
  controlState,
  controlStateFromConfig,
  readControlMessage,
} from '@core/runtime/control';

const line = (command: unknown) => JSON.stringify({ type: 'command', command });

describe('what a client may send', () => {
  it('each allowed command, well-formed, gets through', () => {
    const accepted = [
      { type: 'focus-service', serviceId: 'svc-1' },
      { type: 'set-dnd', on: true, until: null },
      { type: 'mute-service', serviceId: 'svc-1', until: 1_900_000_000_000 },
      { type: 'mark-all-read' },
      { type: 'focus-next-unread' },
      { type: 'cycle-pane', delta: 1 },
      { type: 'show-window' },
      { type: 'meeting-control', serviceId: 'svc-1', control: 'mute', want: true },
    ];
    for (const command of accepted) {
      const message = readControlMessage(line(command));
      assert.equal(message.ok, true, JSON.stringify(command));
      if (message.ok) assert.deepEqual(message.command, command);
    }
  });

  it('A COMMAND THE APP HAS BUT THE SOCKET DOES NOT IS REFUSED — by name', () => {
    for (const type of ['remove-service', 'sign-out-account', 'import-config', 'update-service', 'set-preference']) {
      const message = readControlMessage(line({ type, serviceId: 'svc-1', accountId: 'a', patch: {}, path: 'x', value: 1 }));
      assert.equal(message.ok, false, type);
    }
  });

  it('a malformed command is refused, the same check as shell:command', () => {
    assert.equal(readControlMessage(line({ type: 'focus-service' })).ok, false, 'no serviceId');
    assert.equal(readControlMessage(line({ type: 'cycle-pane', delta: '1' })).ok, false, 'string delta');
    assert.equal(readControlMessage(line({ type: 'set-dnd', on: 'yes', until: null })).ok, false, 'string on');
  });

  it('only command messages, and only JSON objects', () => {
    assert.equal(readControlMessage('not json').ok, false);
    assert.equal(readControlMessage('[]').ok, false);
    assert.equal(readControlMessage('null').ok, false);
    assert.equal(readControlMessage(JSON.stringify({ type: 'subscribe' })).ok, false);
    assert.equal(readControlMessage(JSON.stringify({ type: 'link', link: 'hangar://open/slack' })).ok, false);
  });
});

describe('the allowlist itself', () => {
  it('every entry is a real command type', () => {
    const all = new Set(commandTypes());
    for (const type of CONTROL_COMMAND_TYPES) assert.ok(all.has(type), type);
  });

  it('WHAT A LINK CAN DO, THE SOCKET CAN — except the patch, which it has mute-service for', () => {
    for (const type of LINK_COMMAND_TYPES) {
      if (type === 'update-service') assert.equal(CONTROL_COMMAND_TYPES.has(type), false);
      else assert.ok(CONTROL_COMMAND_TYPES.has(type), type);
    }
  });

  it('A MEETING PRESS IS THE SOCKET\'S ALONE — never a link verb, and it never brings the window up', () => {
    assert.ok(CONTROL_COMMAND_TYPES.has('meeting-control'));
    assert.equal(LINK_COMMAND_TYPES.has('meeting-control'), false);
    assert.equal(CONTROL_SHOWS.has('meeting-control'), false);
  });

  it('what brings the window forward is on the allowlist, and settings never do', () => {
    for (const type of CONTROL_SHOWS) assert.ok(CONTROL_COMMAND_TYPES.has(type), type);
    for (const type of ['set-dnd', 'mute-service', 'mark-read', 'mark-all-read'] as const) {
      assert.equal(CONTROL_SHOWS.has(type), false, type);
    }
  });
});

describe('what a client is told', () => {
  const view = (over: Record<string, unknown>) => ({
    id: 'svc-1',
    catalogId: 'slack',
    name: 'Slack',
    color: '#4a154b',
    initials: 'S',
    unread: 0,
    sleeping: false,
    loading: false,
    customCss: 'body { display: none }',
    customJs: 'alert(1)',
    ...over,
  });
  const state = {
    allServices: [
      view({ unread: 3 }),
      view({ id: 'svc-2', catalogId: 'gmail', name: 'Gmail', unread: 2, notificationLevel: 'muted', mutedUntil: 42 }),
    ],
    services: [],
    preferences: { notifications: { dnd: true, dndUntil: 99 } },
    workspaces: [{ id: 'w-a', name: 'Work', items: [{ type: 'service', id: 'svc-1' }] }],
    activeWorkspaceId: 'w-a',
    panes: [
      { id: 'p-1', serviceId: 'svc-1' },
      { id: 'p-2', serviceId: 'svc-2' },
    ],
    focusedPaneId: 'p-2',
  } as unknown as ShellState;

  it('every service, its unread, mutes and Do Not Disturb, and which one is focused', () => {
    const control = controlState(state);
    assert.equal(control.window, true);
    assert.equal(control.dnd, true);
    assert.equal(control.dndUntil, 99);
    assert.equal(control.unreadTotal, 5);
    assert.equal(control.focusedServiceId, 'svc-2');
    assert.deepEqual(control.workspaces, [{ id: 'w-a', name: 'Work' }]);
    assert.deepEqual(control.services[1], {
      id: 'svc-2',
      name: 'Gmail',
      catalogId: 'gmail',
      icon: 'gmail',
      color: '#4a154b',
      initials: 'S',
      unread: 2,
      muted: true,
      mutedUntil: 42,
      sleeping: false,
    });
  });

  it('THE ICON IS THE CATALOG\'S FILE NAME, not the catalog id', () => {
    const control = controlState({ ...state, allServices: [view({ catalogId: 'gcal' })] } as unknown as ShellState);
    assert.equal(control.services[0]?.icon, 'google-calendar');
  });

  it("a service's meeting goes along when it has one", () => {
    const meeting = { inCall: true, controls: { mute: false } };
    const control = controlState({ ...state, allServices: [view({ meeting })] } as unknown as ShellState);
    assert.deepEqual(control.services[0]?.meeting, meeting);
    assert.equal('meeting' in (controlState(state).services[0] ?? {}), false);
  });

  it('NO SERVICE CODE, NO RAIL TREE — only the fields it names', () => {
    const text = JSON.stringify(controlState(state));
    assert.equal(text.includes('alert(1)'), false);
    assert.equal(text.includes('display: none'), false);
    assert.equal(text.includes('items'), false);
  });

  it('with no window, the settings and nothing unread', () => {
    const config = {
      services: [{ id: 'svc-1', catalogId: 'slack', name: 'Slack', notificationLevel: 'muted' }],
      workspaces: [{ id: 'w-a', name: 'Work', items: [] }],
      activeWorkspaceId: 'w-a',
      preferences: { notifications: { dnd: false, dndUntil: null } },
    } as unknown as Config;
    const control = controlStateFromConfig(config);
    assert.equal(control.window, false);
    assert.equal(control.unreadTotal, 0);
    assert.deepEqual(control.services, [
      { id: 'svc-1', name: 'Slack', catalogId: 'slack', icon: 'slack', unread: 0, muted: true, mutedUntil: null, sleeping: false },
    ]);
  });
});

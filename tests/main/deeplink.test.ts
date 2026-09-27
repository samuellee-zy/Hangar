// `hangar://` links and the command line. The property that matters most is the last block: a link
// can be opened by any page, so what it can make the app do is a short list, and no input escapes it.

import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import type { Config } from '@shared/types';
import { isCommand } from '@core/commands';
import {
  LINK_COMMAND_TYPES,
  findService,
  findWorkspace,
  linksFromArgv,
  parseLink,
  resolveLink,
} from '@core/runtime/deeplink';

const config = {
  version: 5,
  services: [
    { id: 'svc-1', catalogId: 'gmail', name: 'Gmail' },
    { id: 'svc-2', catalogId: 'gmail', name: 'Work mail' },
    { id: 'svc-3', catalogId: 'slack', name: 'Slack' },
  ],
  workspaces: [
    { id: 'w-a', name: 'Personal', items: [] },
    { id: 'w-b', name: 'Work', items: [] },
  ],
  activeWorkspaceId: 'w-a',
  layouts: {},
  accounts: [],
  preferences: {},
} as unknown as Config;

const NOW = new Date(2026, 8, 27, 14, 0).getTime();
const commands = (link: string) => {
  const result = resolveLink(link, config, NOW);
  if (!result.ok) throw new Error(result.error);
  return result.value.commands;
};
const errorOf = (link: string) => {
  const result = resolveLink(link, config, NOW);
  return result.ok ? null : result.error;
};

describe('what a link says', () => {
  it('each verb, in both spellings of the scheme', () => {
    assert.deepEqual(commands('hangar://open/slack'), [{ type: 'focus-service', serviceId: 'svc-3' }]);
    assert.deepEqual(commands('hangar:open/slack'), [{ type: 'focus-service', serviceId: 'svc-3' }]);
    assert.deepEqual(commands('hangar://open/slack?pane=new'), [{ type: 'open-in-new-pane', serviceId: 'svc-3' }]);
    assert.deepEqual(commands('hangar://workspace/work'), [{ type: 'set-workspace', workspaceId: 'w-b' }]);
    assert.deepEqual(commands('hangar://dnd/on'), [{ type: 'set-dnd', on: true, until: null }]);
    assert.deepEqual(commands('hangar://dnd/off'), [{ type: 'set-dnd', on: false, until: null }]);
    assert.deepEqual(commands('hangar://unmute/Slack'), [{ type: 'mute-service', serviceId: 'svc-3', until: null }]);
    assert.deepEqual(commands('hangar://read/all'), [{ type: 'mark-all-read' }]);
    assert.deepEqual(commands('hangar://read/gmail'), [{ type: 'mark-read', serviceId: 'svc-1' }]);
    assert.deepEqual(commands('hangar://'), []);
    assert.deepEqual(commands('HANGAR://OPEN/Slack'), [{ type: 'focus-service', serviceId: 'svc-3' }], 'case');
  });

  it('A NAME WITH SPACES, ENCODED — the way Shortcuts writes it', () => {
    assert.deepEqual(commands('hangar://open/Work%20mail'), [{ type: 'focus-service', serviceId: 'svc-2' }]);
  });

  it('durations: minutes, tomorrow, or until turned off', () => {
    assert.deepEqual(commands('hangar://dnd/on?for=30'), [{ type: 'set-dnd', on: true, until: NOW + 30 * 60_000 }]);
    const [tomorrow] = commands('hangar://dnd/on?for=tomorrow') as Array<{ until: number }>;
    assert.equal(new Date(tomorrow!.until).getHours(), 9);
    assert.equal(new Date(tomorrow!.until).getDate(), 28);
    assert.deepEqual(commands('hangar://mute/slack?for=60'), [
      { type: 'mute-service', serviceId: 'svc-3', until: NOW + 60 * 60_000 },
    ]);
    // Without a duration, the tile menu's "Until I unmute it".
    assert.deepEqual(commands('hangar://mute/slack'), [
      { type: 'update-service', serviceId: 'svc-3', patch: { notificationLevel: 'muted' } },
    ]);
    // Turning off takes no duration, whatever the link says.
    assert.deepEqual(commands('hangar://dnd/off?for=30'), [{ type: 'set-dnd', on: false, until: null }]);
  });

  it('show says whether to bring the window forward — a background DND must not', () => {
    const show = (link: string) => {
      const result = resolveLink(link, config, NOW);
      return result.ok && result.value.show;
    };
    assert.equal(show('hangar://open/slack'), true);
    assert.equal(show('hangar://workspace/work'), true);
    assert.equal(show('hangar://'), true);
    assert.equal(show('hangar://dnd/on'), false);
    assert.equal(show('hangar://mute/slack'), false);
    assert.equal(show('hangar://read/all'), false);
  });

  it('A LINK THAT MEANS NOTHING SAYS WHY', () => {
    assert.match(errorOf('hangar://open/nobody')!, /no service is called "nobody"/);
    assert.match(errorOf('hangar://workspace/nowhere')!, /no workspace/);
    assert.match(errorOf('hangar://open/')!, /needs a service/);
    assert.match(errorOf('hangar://dnd/maybe')!, /on or off/);
    assert.match(errorOf('hangar://dnd/on?for=soon')!, /minutes/);
    assert.match(errorOf('hangar://dnd/on?for=0')!, /minutes/);
    assert.match(errorOf('hangar://dnd/on?for=1.5')!, /minutes/);
    assert.match(errorOf('hangar://open/%E0%A4%A')!, /malformed/);
    assert.match(errorOf('hangar://remove-service/slack')!, /there is no "remove-service"/);
    assert.match(errorOf('https://example.com')!, /not a hangar/);
    assert.match(errorOf(`hangar://open/${'x'.repeat(5000)}`)!, /too long/);
  });
});

describe('finding what a link names', () => {
  it('A TIE GOES TO THE ONE HIGHER IN THE RAIL — not the one added first', () => {
    const reordered = {
      ...config,
      services: [
        { id: 'svc-1', catalogId: 'gmail', name: 'Personal mail' },
        { id: 'svc-2', catalogId: 'gmail', name: 'Work mail' },
      ],
      workspaces: [
        { id: 'w-a', name: 'Personal', items: [{ kind: 'service', id: 'svc-2' }, { kind: 'service', id: 'svc-1' }] },
        { id: 'w-b', name: 'Work', items: [] },
      ],
    } as unknown as Config;
    assert.equal(findService(reordered, 'gmail')?.id, 'svc-2');
    assert.equal(findService(reordered, 'SVC-1')?.id, 'svc-1', 'ids, like names, in any case');
  });

  it('a service by id, then name, then catalog entry — the name is the one the user chose', () => {
    assert.equal(findService(config, 'svc-2')?.id, 'svc-2');
    assert.equal(findService(config, 'work MAIL')?.id, 'svc-2');
    // Two Gmails by catalog: the first in the list. By its own name, the one called that.
    assert.equal(findService(config, 'gmail')?.id, 'svc-1');
    assert.equal(findService(config, 'slack')?.id, 'svc-3');
  });

  it('a workspace by id, name, or its place in the switcher', () => {
    assert.equal(findWorkspace(config, 'w-b')?.id, 'w-b');
    assert.equal(findWorkspace(config, 'work')?.id, 'w-b');
    assert.equal(findWorkspace(config, '1')?.id, 'w-a');
    assert.equal(findWorkspace(config, '3'), undefined);
  });
});

describe('the command line', () => {
  it('flags become the links they mean', () => {
    assert.deepEqual(linksFromArgv(['--open', 'Work mail']), ['hangar://open/Work%20mail']);
    assert.deepEqual(linksFromArgv(['--open=slack', '--new-pane']), ['hangar://open/slack?pane=new']);
    assert.deepEqual(linksFromArgv(['--dnd', 'on', '--for', '45']), ['hangar://dnd/on?for=45']);
    assert.deepEqual(linksFromArgv(['--mute', 'slack', '--for=tomorrow']), ['hangar://mute/slack?for=tomorrow']);
    assert.deepEqual(linksFromArgv(['--mark-read', 'all', '--workspace', '2']), [
      'hangar://read/all',
      'hangar://workspace/2',
    ]);
    assert.deepEqual(linksFromArgv(['--unmute', 'slack']), ['hangar://unmute/slack']);
  });

  it("IGNORES WHAT ISN'T OURS — this is the whole argv, Chromium's switches included", () => {
    assert.deepEqual(
      linksFromArgv([
        '/Applications/Hangar.app/Contents/MacOS/Hangar',
        '--allow-file-access-from-files',
        '--open',
        '--quit',
        'hangar://read/all',
        '--for',
        '30',
        'constructor',
        'x',
      ]),
      ['hangar://read/all'],
      'a flag with no value is dropped, and a stray --for qualifies nothing',
    );
  });

  it('and each one resolves like the link', () => {
    for (const link of linksFromArgv(['--open', 'slack', '--dnd', 'on', '--for', '10'])) {
      assert.equal(resolveLink(link, config, NOW).ok, true, link);
    }
  });
});

describe('WHAT A LINK CAN DO IS A SHORT LIST — any page can open one', () => {
  const hostile = [
    'hangar://open/slack',
    'hangar://open/slack?pane=new&type=remove-service',
    'hangar://workspace/work',
    'hangar://dnd/on?for=10',
    'hangar://mute/slack',
    'hangar://mute/slack?for=tomorrow&patch=%7B%22customJs%22%3A%22x%22%7D',
    'hangar://unmute/slack',
    'hangar://read/all',
    'hangar://read/svc-1',
    'hangar://remove-service/slack',
    'hangar://import-config/x',
    'hangar://sign-out/acct',
    'hangar://update-service/slack?patch=%7B%7D',
    'hangar://open/%7B%22type%22%3A%22remove-service%22%7D',
  ];

  it('every command it produces is one of eight types, and well-formed', () => {
    for (const link of hostile) {
      const result = resolveLink(link, config, NOW);
      if (!result.ok) continue;
      for (const command of result.value.commands) {
        assert.ok(LINK_COMMAND_TYPES.has(command.type), `${link} → ${command.type}`);
        assert.equal(isCommand(command), true, `${link} → ${JSON.stringify(command)}`);
      }
    }
  });

  it('THE ONE UPDATE IT CAN MAKE IS A MUTE — nothing from the link is in the patch', () => {
    for (const link of hostile) {
      const result = resolveLink(link, config, NOW);
      if (!result.ok) continue;
      for (const command of result.value.commands) {
        if (command.type === 'update-service') assert.deepEqual(command.patch, { notificationLevel: 'muted' });
      }
    }
  });

  it('a name that is a command is looked up as a name, and found to be nothing', () => {
    assert.match(errorOf('hangar://open/%7B%22type%22%3A%22remove-service%22%7D')!, /no service is called/);
  });

  it('parses without throwing, whatever it is given', () => {
    for (const junk of ['hangar:', 'hangar://%', 'hangar://open/%', 'hangar:////', 'hangar://?a=%ZZ', 'hangar://dnd']) {
      assert.doesNotThrow(() => parseLink(junk), junk);
    }
  });
});

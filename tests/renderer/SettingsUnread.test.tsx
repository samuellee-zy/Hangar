// The unread-selector editor.
//
// Two things here are easy to get wrong and invisible when you do. The note under each service name
// claims which of six paths its count is taking, and a wrong claim is worse than no claim — "your
// selector" and "detection off" look the same in a screenshot and mean opposite things. And the
// field has to distinguish *cleared* from *unset*, because clearing it is the only way to switch
// off a catalog rule while unsetting it is the only way to get one back.

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Unread, describeReading, hasSleepingEndpoint, unreadSourceOf } from '../../src/renderer/settings/Unread';
import { sent } from './setup';
import { DEFAULT_PREFERENCES } from '../../src/core/config/preferences';
import type { ServiceInstance, ShellState } from '../../src/shared/types';

const svc = (over: Partial<ServiceInstance> = {}): ServiceInstance =>
  ({
    id: 's1',
    // Notion: a real catalog entry with no unread detection of any kind, which is the case the
    // whole field exists for.
    catalogId: 'notion',
    name: 'Notion',
    accountId: 'a1',
    notifications: true,
    hibernate: true,
    zoom: 1,
    ...over,
  }) as ServiceInstance;

const state = (services: ServiceInstance[], over: Partial<ShellState> = {}): ShellState =>
  ({
    services: [],
    allServices: services,
    railItems: [],
    preferences: DEFAULT_PREFERENCES,
    orphanPartitions: [],
    quarantinedConfigs: [],
    syncStatus: { state: 'off' },
    accounts: [],
    workspaces: [],
    panes: [],
    focusedPaneId: null,
    activeWorkspaceId: null,
    railExpanded: false,
    keyboard: { actions: [], reserved: [], passthrough: {} },
    ...over,
  }) as ShellState;

describe('unreadSourceOf', () => {
  it('reports the catalog title pattern where there is one', () => {
    expect(unreadSourceOf(svc({ catalogId: 'gmail' }))).toBe('title');
  });

  it('reports catalog DOM rules where there are those', () => {
    expect(unreadSourceOf(svc({ catalogId: 'gitlab' }))).toBe('catalog');
  });

  it('a service with no detection is counting notifications, and says so', () => {
    expect(unreadSourceOf(svc())).toBe('events');
  });

  it("A USER'S SELECTOR OVERRIDES THE CATALOG'S TITLE PATTERN", () => {
    expect(unreadSourceOf(svc({ catalogId: 'gmail', unreadSelector: '.mine' }))).toBe('custom');
  });

  it('CLEARED IS NOT UNSET — an empty selector reads as detection off', () => {
    expect(unreadSourceOf(svc({ catalogId: 'gmail', unreadSelector: '' }))).toBe('disabled');
    expect(unreadSourceOf(svc({ catalogId: 'gmail', unreadSelector: '  ' }))).toBe('disabled');
  });

  it('MUTING WINS OVER EVERYTHING, because detection does not run at all then', () => {
    // Describing a rule that will never fire is the note being confidently wrong.
    expect(unreadSourceOf(svc({ catalogId: 'gmail', notificationLevel: 'muted' }))).toBe('off');
    expect(unreadSourceOf(svc({ catalogId: 'gmail', notifications: false }))).toBe('off');
    expect(unreadSourceOf(svc({ unreadSelector: '.mine', notifications: false }))).toBe('off');
  });
});

describe('hasSleepingEndpoint', () => {
  it('is reported alongside the source, not instead of it', () => {
    // Gmail reads its title *and* has a feed to ask while asleep, because the two cover disjoint
    // cases. Folding the endpoint into `UnreadSource` would force a choice that does not exist.
    const gmail = svc({ catalogId: 'gmail' });
    expect(unreadSourceOf(gmail)).toBe('title');
    expect(hasSleepingEndpoint(gmail)).toBe(true);
  });

  it('NULL IS "CALL NOTHING", and is not the same as unset', () => {
    expect(hasSleepingEndpoint(svc({ catalogId: 'gmail', unreadEndpoint: null }))).toBe(false);
    expect(hasSleepingEndpoint(svc({ catalogId: 'gmail', unreadEndpoint: undefined }))).toBe(true);
  });

  it('a muted service is not called on in the background either', () => {
    expect(hasSleepingEndpoint(svc({ catalogId: 'gmail', notificationLevel: 'muted' }))).toBe(false);
  });

  it('a service with no rule anywhere has none', () => {
    expect(hasSleepingEndpoint(svc())).toBe(false);
  });
});

describe('the unread selector field', () => {
  it('commits a typed selector on blur', async () => {
    const user = userEvent.setup();
    render(<Unread state={state([svc()])} />);

    await user.click(screen.getByTitle("CSS selector for Notion's unread badge"));
    await user.keyboard('.sidebar-badge');
    await user.tab();

    expect(sent).toContainEqual({
      type: 'update-service',
      serviceId: 's1',
      patch: { unreadSelector: '.sidebar-badge' },
    });
  });

  it('COMMITS AN EMPTY SELECTOR, which the shared field would otherwise discard', async () => {
    // `CommitOnBlur` ignores an emptied field by default, and rightly: blanking a workspace name is
    // a slip. Here it is the only way to turn a catalog rule off, so this field opts in — and if
    // that opt-in is ever dropped, clearing the box silently does nothing.
    const user = userEvent.setup();
    render(<Unread state={state([svc({ unreadSelector: '.old' })])} />);

    await user.clear(screen.getByTitle("CSS selector for Notion's unread badge"));
    await user.tab();

    expect(sent).toContainEqual({
      type: 'update-service',
      serviceId: 's1',
      patch: { unreadSelector: '' },
    });
  });

  it('Default sends undefined, which is how the catalog rule comes back', async () => {
    const user = userEvent.setup();
    render(<Unread state={state([svc({ unreadSelector: '' })])} />);

    await user.click(screen.getByRole('button', { name: 'Default' }));

    const patch = sent.at(-1) as { patch: Record<string, unknown> };
    expect(patch.patch).toHaveProperty('unreadSelector', undefined);
    // `in`, not a truthiness check: main decides whether to act on this by asking whether the key
    // is present, so a patch that dropped it would be a silent no-op.
    expect('unreadSelector' in patch.patch).toBe(true);
  });

  it('Default is disabled when there is nothing to reset', () => {
    render(<Unread state={state([svc()])} />);
    expect(screen.getByRole('button', { name: 'Default' })).toBeDisabled();
  });

  it('shows the live count, which is what makes a selector tunable', () => {
    const service = svc({ unreadSelector: '.badge' });
    render(
      <Unread
        state={state([service], { services: [{ ...service, unread: 4 }] as ShellState['services'] })}
      />
    );
    expect(screen.getByText(/your selector · showing 4/)).toBeInTheDocument();
  });
});

describe('what each count was read from', () => {
  const now = 1_000_000;
  it("SAYS THE TITLE BEHIND WHATSAPP'S 1 — it counts chats, and the 27 was messages in one", () => {
    expect(describeReading({ source: 'title', count: 1, detail: '(1) WhatsApp', at: now }, now)).toBe(
      'Read 1 from its title, “(1) WhatsApp” · just now',
    );
    expect(describeReading({ source: 'page', count: null, detail: 'page not drawn yet', at: now }, now)).toMatch(
      /^Nothing read from the page yet/,
    );
    expect(describeReading({ source: 'notifications', count: 2, detail: '', at: now - 5 * 60_000 }, now)).toBe(
      'Counted 2 from notifications it sent · 5 min ago',
    );
  });

  it('shows the reading under the service it belongs to', () => {
    const wa = svc({ id: 'wa', catalogId: 'whatsapp', name: 'WhatsApp' });
    render(
      <Unread
        state={state([wa], { unreadEvidence: { wa: { source: 'title', count: 1, detail: '(1) WhatsApp', at: Date.now() } } })}
      />,
    );
    expect(screen.getByText(/Read 1 from its title, “\(1\) WhatsApp”/)).toBeInTheDocument();
  });
});


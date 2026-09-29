// Sections that were unreachable while Settings was one 679-line render function.
//
// These are the rows with a *condition* attached — a disabled button, a note that changes wording,
// a list that hides itself when empty. Conditions are where the wrong branch is invisible until
// someone hits it.

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Workspaces } from '../../src/renderer/settings/Connections';
import { ServiceList, ServiceSettings } from '../../src/renderer/settings/ServiceSettings';
import { Notifications, pushReadiness } from '../../src/renderer/settings/Notifications';
import { Storage } from '../../src/renderer/settings/Storage';
import { sent } from './setup';
import { DEFAULT_PREFERENCES } from '../../src/core/config/preferences';
import type { ServiceView, ShellState } from '../../src/shared/types';

const svc = (id: string, over: Partial<ServiceView> = {}): ServiceView =>
  ({
    id,
    catalogId: 'gmail',
    name: id,
    accountId: 'a1',
    notifications: true,
    hibernate: true,
    zoom: 1,
    initials: 'XX',
    color: '#4A154B',
    loading: false,
    sleeping: false,
    unread: 0,
    ...over,
  }) as ServiceView;

const state = (over: Partial<ShellState> = {}): ShellState =>
  ({
    services: [],
    allServices: [],
    railItems: [],
    preferences: DEFAULT_PREFERENCES,
    orphanPartitions: [],
    quarantinedConfigs: [],
    syncStatus: { state: 'off' },
    accounts: [],
    workspaces: [{ id: 'w1', name: 'Work', items: [] }],
    panes: [],
    focusedPaneId: null,
    activeWorkspaceId: 'w1',
    ...over,
  }) as ShellState;

describe('workspaces', () => {
  it('THE LAST WORKSPACE CANNOT BE DELETED, and says why', () => {
    // Deleting it would leave the rail with nothing to render and no way to make a new one.
    render(<Workspaces state={state()} />);

    const button = screen.getByRole('button', { name: 'Delete' });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('title', expect.stringMatching(/last workspace/i));
  });

  it('deleting is allowed once there are two', async () => {
    render(
      <Workspaces
        state={state({
          workspaces: [
            { id: 'w1', name: 'Work', items: [] },
            { id: 'w2', name: 'Home', items: [] },
          ],
        })}
      />
    );

    // By title, not by name: every row's button reads "Delete", so the name alone is ambiguous
    // the moment there is more than one workspace — which is the case under test.
    // Two clicks: the first arms it, and sends nothing.
    await userEvent.click(screen.getByTitle('Delete Work'));
    expect(sent).not.toContainEqual({ type: 'delete-workspace', workspaceId: 'w1' });
    expect(screen.getByRole('button', { name: 'Delete Work?' })).toBeInTheDocument();

    await userEvent.click(screen.getByTitle('Delete Work'));
    expect(sent).toContainEqual({ type: 'delete-workspace', workspaceId: 'w1' });
  });

  it('marks the active workspace and pluralises its item count', () => {
    render(
      <Workspaces
        state={state({
          workspaces: [
            { id: 'w1', name: 'Work', items: [{ kind: 'service', id: 's1' }] },
            { id: 'w2', name: 'Home', items: [] },
          ],
          activeWorkspaceId: 'w1',
        })}
      />
    );

    expect(screen.getByText(/active · 1 item$/)).toBeInTheDocument();
    expect(screen.getByText(/^0 items$/)).toBeInTheDocument();
  });
});

describe("a service's own page: allowed hosts", () => {
  const page = (service: ServiceView) =>
    render(<ServiceSettings state={state({ allServices: [service] })} svc={service} onBack={() => {}} />);

  it('HOSTS CAN BE ADDED HERE — the hint said to, and there was no field', async () => {
    page(svc('intranet', { allowedHosts: ['intranet.acme.com'] }));
    const field = screen.getByLabelText('Extra allowed hosts for intranet');
    await userEvent.type(field, 'Login.Okta.com, sso.acme.com login.okta.com{Enter}');
    expect(sent).toContainEqual({
      type: 'update-service',
      serviceId: 'intranet',
      patch: { extraAllowedHosts: ['login.okta.com', 'sso.acme.com'] },
    });
  });

  it('a catalog service gets the field too — company SSO in front of a catalog app', () => {
    page(svc('gmail'));
    expect(screen.getByLabelText('Extra allowed hosts for gmail')).toBeInTheDocument();
  });

  it('clearing the field removes the extra hosts', async () => {
    page(svc('gmail', { extraAllowedHosts: ['sso.acme.com'] }));
    const field = screen.getByLabelText('Extra allowed hosts for gmail');
    await userEvent.clear(field);
    await userEvent.tab();
    expect(sent).toContainEqual({ type: 'update-service', serviceId: 'gmail', patch: { extraAllowedHosts: [] } });
  });

  it("shows the service's own allowlist", () => {
    page(svc('intranet', { allowedHosts: ['intranet.acme.com', 'login.okta.com'] }));
    expect(screen.getByText(/intranet\.acme\.com, login\.okta\.com/)).toBeInTheDocument();
  });
});

describe('the list of connections', () => {
  it('ONE ROW A SERVICE, AND EACH OPENS ITS PAGE — every service was listed four times here', async () => {
    const opened: string[] = [];
    render(
      <ServiceList
        state={state({ allServices: [svc('gmail'), svc('slack')] })}
        onOpen={(id) => opened.push(id)}
      />,
    );
    expect(screen.getAllByRole('button', { name: /^Settings for / })).toHaveLength(2);
    await userEvent.click(screen.getByRole('button', { name: 'Settings for slack' }));
    expect(opened).toEqual(['slack']);
  });

  it('says so when there are no connections, rather than showing an empty list', () => {
    render(<ServiceList state={state({ allServices: [] })} onOpen={() => {}} />);
    expect(screen.getByText(/no connections yet/i)).toBeInTheDocument();
  });
});

describe('unused sessions', () => {
  it('THE PURGE BUTTON IS DISABLED WITH NOTHING TO PURGE', () => {
    // A live button that does nothing reads as a broken button.
    render(<Storage state={state()} />);

    expect(screen.getByRole('button', { name: 'Delete' })).toBeDisabled();
    expect(screen.getByText(/nothing to clean up/i)).toBeInTheDocument();
  });

  it('counts what is there and sends the purge', async () => {
    render(<Storage state={state({ orphanPartitions: ['persist:a', 'persist:b'] })} />);

    expect(screen.getByText('2 left by removed connections')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(sent).not.toContainEqual({ type: 'purge-orphan-partitions' });
    await userEvent.click(screen.getByRole('button', { name: 'Delete 2?' }));
    expect(sent).toContainEqual({ type: 'purge-orphan-partitions' });
  });

  it('the recovered-configuration block is hidden unless there is one', () => {
    // A permanently-empty row inviting you to worry about config corruption is worse than no row.
    render(<Storage state={state()} />);

    expect(screen.queryByRole('heading', { name: /recovered configuration/i })).not.toBeInTheDocument();
  });

  it('offers to reveal a quarantined copy, which is the only pointer the user gets', async () => {
    const file = '/Users/me/config.json.corrupt-1700000000000';
    render(<Storage state={state({ quarantinedConfigs: [file] })} />);

    expect(screen.getByText(file)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /show in finder/i }));
    expect(sent).toContainEqual({ type: 'reveal-path', path: file });
  });
});

describe('web push readiness', () => {
  const firebase = (over: Partial<Record<string, string>> = {}) => ({
    projectId: '',
    appId: '',
    apiKey: '',
    messagingSenderId: '',
    ...over,
  });

  it('distinguishes NOTHING FILLED IN from HALF FILLED IN', () => {
    // "Set this up" and "you are two fields from done" are different messages, and showing the
    // wrong one is silently unhelpful.
    expect(pushReadiness(firebase()).status).toBe('unset');
    expect(pushReadiness(firebase({ projectId: 'p' })).status).toBe('incomplete');
    expect(
      pushReadiness(firebase({ projectId: 'p', appId: 'a', apiKey: 'k', messagingSenderId: 's' }))
        .status
    ).toBe('ready');
  });

  it('treats whitespace as absent, since a space is not a credential', () => {
    expect(
      pushReadiness(firebase({ projectId: '  ', appId: 'a', apiKey: 'k', messagingSenderId: 's' }))
        .status
    ).toBe('incomplete');
  });

  it('names exactly what is still missing', () => {
    expect(pushReadiness(firebase({ projectId: 'p', appId: 'a' })).missing).toEqual([
      'apiKey',
      'messagingSenderId',
    ]);
  });

  it('THE TOGGLE IS DISABLED until the credential is complete', async () => {
    // Enabling push without a Firebase project persists a preference that cannot work, and the
    // failure surfaces much later as "notifications are just broken".
    const { rerender } = render(
      <Notifications
        notifications={{ ...DEFAULT_PREFERENCES.notifications, firebase: firebase() }}
      />
    );

    const toggle = () => screen.getByRole('checkbox', { name: /enable web push/i });
    expect(toggle()).toBeDisabled();

    rerender(
      <Notifications
        notifications={{
          ...DEFAULT_PREFERENCES.notifications,
          firebase: firebase({ projectId: 'p', appId: 'a', apiKey: 'k', messagingSenderId: 's' }),
        }}
      />
    );
    expect(toggle()).toBeEnabled();
  });

  it('tells you which fields are outstanding, in the row itself', () => {
    render(
      <Notifications
        notifications={{
          ...DEFAULT_PREFERENCES.notifications,
          firebase: firebase({ projectId: 'p', appId: 'a', apiKey: 'k' }),
        }}
      />
    );

    expect(screen.getByText('Still needed: messagingSenderId')).toBeInTheDocument();
  });

  it('masks the API key, which is a credential in a shared screenshot', () => {
    render(
      <Notifications
        notifications={{
          ...DEFAULT_PREFERENCES.notifications,
          firebase: firebase({ apiKey: 'AIzaSecret' }),
        }}
      />
    );

    expect(screen.getByDisplayValue('AIzaSecret')).toHaveAttribute('type', 'password');
  });
});

describe("a service's own page: start page, CSS, running", () => {
  const page = (service: ServiceView) =>
    render(<ServiceSettings state={state({ allServices: [service] })} svc={service} onBack={() => {}} />);

  it('A SELF-HOSTED START PAGE BRINGS ITS HOST WITH IT — or it would open in the browser', async () => {
    page(svc('gitlab', { catalogId: 'gitlab' }));
    const field = screen.getByLabelText('Start page for gitlab');
    await userEvent.type(field, 'git.acme.io/dashboard{Enter}');
    expect(sent).toContainEqual({
      type: 'update-service',
      serviceId: 'gitlab',
      patch: { url: 'https://git.acme.io/dashboard', extraAllowedHosts: ['git.acme.io'] },
    });
  });

  it('a start page on an already-allowed host changes only the URL', async () => {
    page(svc('gitlab', { catalogId: 'gitlab' }));
    await userEvent.type(screen.getByLabelText('Start page for gitlab'), 'https://gitlab.com/acme{Enter}');
    expect(sent).toContainEqual({ type: 'update-service', serviceId: 'gitlab', patch: { url: 'https://gitlab.com/acme' } });
  });

  it('custom CSS commits when you leave the box, not per keystroke', async () => {
    page(svc('gmail'));
    const area = screen.getByLabelText('Custom CSS for gmail');
    await userEvent.type(area, '.ad{{display:none}');
    expect(sent.filter((c) => (c as { type: string }).type === 'update-service')).toEqual([]);
    await userEvent.tab();
    expect(sent).toContainEqual({ type: 'update-service', serviceId: 'gmail', patch: { customCss: '.ad{display:none}' } });
  });

  it('KEEP RUNNING IS HERE, AND WHILE IT IS ON, HIBERNATION SAYS WHY IT IS OFF', async () => {
    page(svc('slack', { keepRunning: true }));
    expect(screen.getByLabelText('Keep running')).toBeChecked();
    expect(screen.getByLabelText('Hibernate when idle')).toBeDisabled();
    expect(screen.getByText('Not while it is set to keep running')).toBeInTheDocument();
    await userEvent.click(screen.getByLabelText('Keep running'));
    expect(sent).toContainEqual({ type: 'update-service', serviceId: 'slack', patch: { keepRunning: false } });
  });

  it('WITH EVERY SERVICE KEPT RUNNING, ITS OWN SWITCH SAYS SO — and waits, rather than looking off', () => {
    const everything = { ...DEFAULT_PREFERENCES, behaviour: { ...DEFAULT_PREFERENCES.behaviour, keepAllRunning: true } };
    const service = svc('slack');
    render(<ServiceSettings state={state({ allServices: [service], preferences: everything })} svc={service} onBack={() => {}} />);
    expect(screen.getByLabelText('Keep running')).toBeChecked();
    expect(screen.getByLabelText('Keep running')).toBeDisabled();
    expect(screen.getByText('On for every service, under General')).toBeInTheDocument();
    expect(screen.getByLabelText('Hibernate when idle')).toBeDisabled();
  });

  it('removing goes back to the list, since the page it was on no longer has a service', async () => {
    let back = 0;
    const service = svc('gmail');
    render(<ServiceSettings state={state({ allServices: [service] })} svc={service} onBack={() => back++} />);
    const remove = screen.getByRole('button', { name: 'Remove' });
    await userEvent.click(remove);
    await userEvent.click(screen.getByRole('button', { name: 'Remove gmail?' }));
    expect(sent).toContainEqual({ type: 'remove-service', serviceId: 'gmail' });
    expect(back).toBe(1);
  });
});

describe('keeping every service running', () => {
  it('IS ONE SWITCH, AND HIBERNATION SAYS IT IS UNUSED WHILE IT IS ON', async () => {
    const { Behaviour } = await import('../../src/renderer/settings/Behaviour');
    const { rerender } = render(<Behaviour behaviour={DEFAULT_PREFERENCES.behaviour} />);
    await userEvent.click(screen.getByLabelText('Keep every service running'));
    expect(sent).toContainEqual({ type: 'set-preference', path: 'behaviour.keepAllRunning', value: true });

    rerender(<Behaviour behaviour={{ ...DEFAULT_PREFERENCES.behaviour, keepAllRunning: true }} />);
    expect(screen.getByText('Unused while every service is kept running')).toBeInTheDocument();
    expect(screen.getByLabelText('Hibernate after')).toBeDisabled();
  });
});

describe('the global shortcut', () => {
  it('IS RECORDED, NOT TYPED — pressing the keys stores an accelerator Electron accepts', async () => {
    const { Behaviour } = await import('../../src/renderer/settings/Behaviour');
    render(<Behaviour behaviour={DEFAULT_PREFERENCES.behaviour} />);
    await userEvent.click(screen.getByRole('button', { name: 'Set a global shortcut' }));
    await userEvent.keyboard('{Meta>}{Shift>}h{/Shift}{/Meta}');
    expect(sent).toContainEqual({
      type: 'set-preference',
      path: 'behaviour.globalShortcut',
      value: 'Shift+Command+H',
    });
  });

  it('SAYS WHEN ANOTHER APP ALREADY HAS IT — that used to reach the log and nowhere else', async () => {
    const { Behaviour } = await import('../../src/renderer/settings/Behaviour');
    render(
      <Behaviour
        behaviour={{ ...DEFAULT_PREFERENCES.behaviour, globalShortcut: 'Command+Shift+Space' }}
        shortcutStatus="taken"
      />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Another app already uses this');
    expect(screen.getByRole('button', { name: /Global shortcut ⌘⇧Space/ })).toBeInTheDocument();
  });

  it('Clear removes it', async () => {
    const { Behaviour } = await import('../../src/renderer/settings/Behaviour');
    render(<Behaviour behaviour={{ ...DEFAULT_PREFERENCES.behaviour, globalShortcut: 'Command+H' }} shortcutStatus="active" />);
    await userEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(sent).toContainEqual({ type: 'set-preference', path: 'behaviour.globalShortcut', value: null });
  });
});

describe('reordering workspaces', () => {
  it('MOVES ONE UP OR DOWN — the order is ⌘⌥1…9, and nothing could change it', async () => {
    render(
      <Workspaces
        state={state({
          workspaces: [
            { id: 'w1', name: 'Work', items: [] },
            { id: 'w2', name: 'Home', items: [] },
          ],
        })}
      />,
    );
    expect(screen.getByRole('button', { name: 'Move Work up' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Move Work down' }));
    expect(sent).toContainEqual({ type: 'reorder-workspaces', workspaceIds: ['w2', 'w1'] });
  });
});

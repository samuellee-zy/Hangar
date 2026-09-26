// Sections that were unreachable while Settings was one 679-line render function.
//
// These are the rows with a *condition* attached — a disabled button, a note that changes wording,
// a list that hides itself when empty. Conditions are where the wrong branch is invisible until
// someone hits it.

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CustomHosts, Workspaces } from '../../src/renderer/settings/Connections';
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

describe('custom connection hosts', () => {
  it('HOSTS CAN BE ADDED HERE NOW — the hint said to, and there was no field', async () => {
    render(<CustomHosts state={state({ allServices: [svc('intranet', { allowedHosts: ['intranet.acme.com'] })] })} />);
    const field = screen.getByLabelText('Extra allowed hosts for intranet');
    await userEvent.type(field, 'Login.Okta.com, sso.acme.com login.okta.com{Enter}');
    expect(sent).toContainEqual({
      type: 'update-service',
      serviceId: 'intranet',
      patch: { extraAllowedHosts: ['login.okta.com', 'sso.acme.com'] },
    });
  });

  it('a catalog service gets the field too — company SSO in front of a catalog app', () => {
    render(<CustomHosts state={state({ allServices: [svc('gmail')] })} />);
    expect(screen.getByLabelText('Extra allowed hosts for gmail')).toBeInTheDocument();
  });

  it('clearing the field removes the extra hosts', async () => {
    render(<CustomHosts state={state({ allServices: [svc('gmail', { extraAllowedHosts: ['sso.acme.com'] })] })} />);
    const field = screen.getByLabelText('Extra allowed hosts for gmail');
    await userEvent.clear(field);
    await userEvent.tab();
    expect(sent).toContainEqual({ type: 'update-service', serviceId: 'gmail', patch: { extraAllowedHosts: [] } });
  });

  it('says so when there are none, rather than showing an empty list', () => {
    render(<CustomHosts state={state({ allServices: [svc('gmail')] })} />);

    expect(screen.getByText(/no custom connections yet/i)).toBeInTheDocument();
  });

  it('lists the allowlist for each custom connection', () => {
    render(
      <CustomHosts
        state={state({
          allServices: [
            svc('gmail'),
            svc('intranet', { allowedHosts: ['intranet.acme.com', 'login.okta.com'] }),
          ],
        })}
      />
    );

    expect(screen.queryByText(/no custom connections yet/i)).not.toBeInTheDocument();
    expect(screen.getByText(/intranet\.acme\.com, login\.okta\.com/)).toBeInTheDocument();
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

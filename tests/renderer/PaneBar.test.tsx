// A pane's bar: the header above a pane, and the title bar speaking for the focused one. It decides
// nothing — main says what to show — so what's worth pinning is that each button sends the command
// the menus do, for the right pane, after choosing that pane; and that it shows what it was sent.

import { describe, it, expect } from 'vitest';
import { render, screen, act, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PaneBar } from '../../src/renderer/PaneBar';
import type { PaneBar as Bar, PaneChromeState } from '../../src/shared/types';
import { sent, setPaneChrome, pushPaneChrome } from './setup';

const bar = (over: Partial<Bar> = {}): Bar => ({
  paneId: 'p2',
  serviceId: 'slack',
  name: 'Slack',
  color: '#4A154B',
  iconVersion: 0,
  title: '#general',
  canGoBack: true,
  canGoForward: false,
  loading: false,
  focused: false,
  maximised: false,
  ...over,
});
const header = (over: Partial<Bar> = {}): PaneChromeState => ({ kind: 'header', bar: bar(over), inset: 0 });

describe('a pane header', () => {
  it('shows the service, and its page when that says more', async () => {
    setPaneChrome(header());
    render(<PaneBar kind="header" />);
    expect(await screen.findByText('Slack')).toBeInTheDocument();
    expect(screen.getByText('#general')).toBeInTheDocument();
    expect(screen.getByRole('toolbar', { name: 'Slack pane' })).toBeInTheDocument();
  });

  it('EVERY BUTTON CHOOSES ITS PANE FIRST — then does what the menu would, for this service', async () => {
    setPaneChrome(header());
    render(<PaneBar kind="header" />);
    await userEvent.click(await screen.findByRole('button', { name: 'Back' }));
    expect(sent).toEqual([
      { type: 'focus-pane', paneId: 'p2' },
      { type: 'navigate', direction: 'back', serviceId: 'slack' },
    ]);
    sent.length = 0;
    await userEvent.click(screen.getByRole('button', { name: 'Reload' }));
    await userEvent.click(screen.getByRole('button', { name: 'Close pane' }));
    expect(sent).toEqual([
      { type: 'focus-pane', paneId: 'p2' },
      { type: 'reload-service', serviceId: 'slack' },
      { type: 'focus-pane', paneId: 'p2' },
      { type: 'close-pane', paneId: 'p2' },
    ]);
  });

  it("can't go where the page can't", async () => {
    setPaneChrome(header({ canGoBack: false, canGoForward: false }));
    render(<PaneBar kind="header" />);
    expect(await screen.findByRole('button', { name: 'Back' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Forward' })).toBeDisabled();
  });

  it('a click on the bar picks the pane; a double-click maximises it', async () => {
    setPaneChrome(header());
    render(<PaneBar kind="header" />);
    const toolbar = await screen.findByRole('toolbar');
    await userEvent.click(toolbar);
    expect(sent).toEqual([{ type: 'focus-pane', paneId: 'p2' }]);
    sent.length = 0;
    await userEvent.dblClick(toolbar);
    expect(sent).toContainEqual({ type: 'toggle-maximise-pane' });
  });

  it('WITH ONE PANE THERE IS NOTHING TO MAXIMISE OR CLOSE — ⌘W on the last one closes the window', async () => {
    setPaneChrome(header({ maximised: null }));
    render(<PaneBar kind="header" />);
    await screen.findByRole('button', { name: 'Back' });
    expect(screen.queryByRole('button', { name: 'Maximise pane' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Close pane' })).toBeNull();
  });

  it('maximised, it offers to restore', async () => {
    setPaneChrome(header({ maximised: true }));
    render(<PaneBar kind="header" />);
    expect(await screen.findByRole('button', { name: 'Restore panes' })).toBeInTheDocument();
  });

  it('follows what main sends next', async () => {
    setPaneChrome(header());
    render(<PaneBar kind="header" />);
    await screen.findByText('#general');
    await act(async () => pushPaneChrome(header({ title: '#random' })));
    expect(screen.getByText('#random')).toBeInTheDocument();
  });
});

describe('dragging a pane by its header', () => {
  it('A PRESS THAT MOVES IS A DRAG — main is told of the lift, each move, and the release', async () => {
    setPaneChrome(header());
    render(<PaneBar kind="header" />);
    const toolbar = await screen.findByRole('toolbar');
    fireEvent.pointerDown(toolbar, { button: 0, clientX: 100, clientY: 15, pointerId: 1 });
    fireEvent.pointerMove(toolbar, { clientX: 103, clientY: 15, pointerId: 1 });
    expect(sent, 'under the lift distance it is still a click').toEqual([]);
    fireEvent.pointerMove(toolbar, { clientX: 140, clientY: 60, pointerId: 1 });
    fireEvent.pointerUp(toolbar, { clientX: 400, clientY: 200, pointerId: 1 });
    fireEvent.click(toolbar);
    expect(sent).toEqual([
      { type: 'begin-pane-drag', paneId: 'p2' },
      { type: 'drag-tile-to', from: 'header', x: 140, y: 60 },
      { type: 'drop-tile', from: 'header', x: 400, y: 200 },
    ]);
  });

  it('a press on a button is the button, never a drag', async () => {
    setPaneChrome(header());
    render(<PaneBar kind="header" />);
    const reload = await screen.findByRole('button', { name: 'Reload' });
    fireEvent.pointerDown(reload, { button: 0, clientX: 100, clientY: 15, pointerId: 1 });
    fireEvent.pointerMove(reload, { clientX: 200, clientY: 15, pointerId: 1 });
    expect(sent).toEqual([]);
  });

  it('with one pane there is nowhere to move it', async () => {
    setPaneChrome(header({ maximised: null }));
    render(<PaneBar kind="header" />);
    const toolbar = await screen.findByRole('toolbar');
    fireEvent.pointerDown(toolbar, { button: 0, clientX: 100, clientY: 15, pointerId: 1 });
    fireEvent.pointerMove(toolbar, { clientX: 200, clientY: 15, pointerId: 1 });
    expect(sent).toEqual([]);
  });
});

describe('the title bar', () => {
  it('speaks for the focused pane, clear of the traffic lights, and has no pane actions', async () => {
    setPaneChrome({ kind: 'titlebar', bar: bar({ focused: true }), inset: 90 });
    render(<PaneBar kind="titlebar" />);
    const toolbar = await screen.findByRole('toolbar', { name: 'Slack, the focused pane' });
    expect(toolbar.style.paddingLeft).toBe('90px');
    expect(screen.queryByRole('button', { name: 'Close pane' })).toBeNull();
    await userEvent.click(toolbar);
    expect(sent, 'a click on the title bar is a window drag, not a command').toEqual([]);
  });

  it('with no pane, is an empty strip that still drags the window', async () => {
    setPaneChrome({ kind: 'titlebar', bar: null, inset: 90 });
    const { container } = render(<PaneBar kind="titlebar" />);
    expect(container.querySelector('.pane-bar.is-titlebar.is-empty')).toBeTruthy();
  });
});

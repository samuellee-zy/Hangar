// The ⌘K palette: keyboard-only by design, so this is where keyboard bugs actually hurt.
//
// The focus-trap cases matter more here than in an ordinary web dialog. The overlay is its own
// WebContentsView — there is no page behind it — so tabbing past the last control doesn't move
// focus somewhere unhelpful, it moves focus somewhere that doesn't visibly exist.

import { describe, it, expect } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Palette } from '../../src/renderer/Palette';
import { sent, setShellState } from './setup';
import { DEFAULT_PREFERENCES } from '../../src/core/config/preferences';
import type { ServiceView, ShellState } from '../../src/shared/types';

const svc = (id: string, name = id): ServiceView =>
  ({
    id,
    catalogId: 'gmail',
    name,
    accountId: 'a',
    notifications: true,
    hibernate: true,
    zoom: 1,
    initials: name.slice(0, 2),
    color: '#4A154B',
    loading: false,
    sleeping: false,
    unread: 0,
  }) as ServiceView;

const state = (over: Partial<ShellState> = {}): ShellState =>
  ({
    services: [svc('gmail', 'Gmail'), svc('slack', 'Slack'), svc('notion', 'Notion')],
    railItems: [],
    allServices: [],
    preferences: DEFAULT_PREFERENCES,
    orphanPartitions: [],
    quarantinedConfigs: [],
    accounts: [],
    workspaces: [{ id: 'w1', name: 'Work', items: [] }],
    panes: [],
    focusedPaneId: null,
    activeWorkspaceId: 'w1',
    ...over,
  }) as ShellState;

async function renderPalette(s: ShellState = state()) {
  setShellState(s);
  const view = render(<Palette />);
  await act(async () => {});
  return view;
}

describe('dialog semantics', () => {
  it('is a labelled modal dialog', async () => {
    await renderPalette();
    const dialog = screen.getByRole('dialog', { name: /command palette/i });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
  });

  it('focuses the input on open, so you can type immediately', async () => {
    await renderPalette();
    expect(document.activeElement).toBe(screen.getByRole('textbox'));
  });
});

describe('the focus trap', () => {
  /**
   * Renders bait outside the dialog.
   *
   * Without this the tests are worthless: jsdom has nothing else focusable, so
   * `dialog.contains(activeElement)` is trivially true and the assertion passes with the trap
   * *disabled*. Verified by disabling it — both tests still went green. The escape hatch has to
   * actually exist for closing it to mean anything.
   */
  async function withBait() {
    const before = document.createElement('button');
    before.textContent = 'before';
    const after = document.createElement('button');
    after.textContent = 'after';
    document.body.prepend(before);
    await renderPalette();
    document.body.append(after);
    return { before, after };
  }

  /**
   * Asserts after EVERY tab, not just the last one.
   *
   * Checking only at the end is a coincidence waiting to happen: with a three-element cycle,
   * twelve tabs land back where they started whether or not the trap exists, and the test passes
   * for the wrong reason. Confirmed — it did.
   */
  async function expectTrapped(shift: boolean, presses: number) {
    const { before, after } = await withBait();
    const dialog = screen.getByRole('dialog');
    for (let i = 0; i < presses; i++) {
      await userEvent.tab({ shift });
      expect(document.activeElement, `escaped after ${i + 1} press(es)`).not.toBe(before);
      expect(document.activeElement, `escaped after ${i + 1} press(es)`).not.toBe(after);
      expect(dialog.contains(document.activeElement)).toBe(true);
    }
  }

  it('TAB WRAPS instead of escaping to nothing', async () => {
    // The overlay is its own WebContentsView. Tab off the end doesn't land on a page behind —
    // it lands nowhere the user can see.
    await expectTrapped(false, 8);
  });

  it('SHIFT-TAB off the first control wraps too — the end people forget', async () => {
    await expectTrapped(true, 8);
  });
});

describe('search and selection', () => {
  it('filters services by subsequence', async () => {
    await renderPalette();
    await userEvent.type(screen.getByRole('textbox'), 'slk');
    expect(screen.getByText('Slack')).toBeInTheDocument();
    expect(screen.queryByText('Notion')).not.toBeInTheDocument();
  });

  it('includes workspaces alongside services', async () => {
    await renderPalette();
    expect(screen.getByText('Work')).toBeInTheDocument();
  });

  it('Enter opens the selected service', async () => {
    await renderPalette();
    await userEvent.keyboard('{Enter}');
    expect(sent).toContainEqual({ type: 'focus-service', serviceId: 'gmail' });
  });

  it('⌘Enter opens it alongside instead of replacing', async () => {
    await renderPalette();
    const user = userEvent.setup();
    await user.keyboard('{Meta>}{Enter}{/Meta}');
    expect(sent).toContainEqual({ type: 'open-in-new-pane', serviceId: 'gmail' });
  });

  it('arrows move the selection and clamp at both ends', async () => {
    await renderPalette();
    // Past the end: three services plus one workspace, so pressing down six times must not run off.
    for (let i = 0; i < 6; i++) await userEvent.keyboard('{ArrowDown}');
    await userEvent.keyboard('{Enter}');
    expect(sent).toContainEqual({ type: 'set-workspace', workspaceId: 'w1' });

    sent.length = 0;
    for (let i = 0; i < 6; i++) await userEvent.keyboard('{ArrowUp}');
    await userEvent.keyboard('{Enter}');
    expect(sent).toContainEqual({ type: 'focus-service', serviceId: 'gmail' });
  });

  it('NARROWING THE QUERY RE-CLAMPS the selection', async () => {
    // Move to the last row, then type something that leaves one result. The index used to stay
    // put, pointing past the end — the highlight vanished and Enter silently did nothing.
    await renderPalette();
    for (let i = 0; i < 3; i++) await userEvent.keyboard('{ArrowDown}');
    await userEvent.type(screen.getByRole('textbox'), 'notion');
    await userEvent.keyboard('{Enter}');
    expect(sent).toContainEqual({ type: 'focus-service', serviceId: 'notion' });
  });

  it('Enter on an empty result set does nothing rather than throwing', async () => {
    await renderPalette();
    await userEvent.type(screen.getByRole('textbox'), 'zzzzz');
    await userEvent.keyboard('{Enter}');
    expect(sent.filter((c) => (c as { type: string }).type !== 'close-overlay')).toEqual([]);
  });

  it('Escape closes the overlay', async () => {
    await renderPalette();
    await userEvent.keyboard('{Escape}');
    expect(sent).toContainEqual({ type: 'close-overlay' });
  });
});

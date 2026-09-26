// Two clicks for things that can't be taken back — and never a stale arm waiting for a click meant
// for something else.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ConfirmButton } from '../../src/renderer/ConfirmButton';

afterEach(() => vi.useRealTimers());

describe('ConfirmButton', () => {
  it('the first click asks, the second does it', async () => {
    const onConfirm = vi.fn();
    render(<ConfirmButton confirmLabel="Remove Gmail?" onConfirm={onConfirm}>Remove</ConfirmButton>);

    await userEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(onConfirm).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Remove Gmail?' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Remove' }), 'back to its resting label').toBeInTheDocument();
  });

  it('DISARMS BY ITSELF after a pause, so a later click starts over', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const onConfirm = vi.fn();
    render(<ConfirmButton confirmLabel="Sure?" onConfirm={onConfirm}>Reset</ConfirmButton>);

    await userEvent.click(screen.getByRole('button', { name: 'Reset' }));
    act(() => vi.advanceTimersByTime(5_000));
    await userEvent.click(screen.getByRole('button', { name: 'Reset' }));
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('disarms on Escape and when focus leaves', async () => {
    const onConfirm = vi.fn();
    render(
      <>
        <ConfirmButton confirmLabel="Sure?" onConfirm={onConfirm}>Delete</ConfirmButton>
        <button>elsewhere</button>
      </>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await userEvent.keyboard('{Escape}');
    expect(screen.getByRole('button', { name: 'Delete' })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Delete' }));
    await userEvent.tab();
    expect(screen.getByRole('button', { name: 'Delete' })).toBeInTheDocument();
    expect(onConfirm).not.toHaveBeenCalled();
  });
});

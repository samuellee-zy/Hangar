// A number preference you can type into. It clamped per keystroke, so with a minimum of 56 the "7"
// of "72" became 56 immediately and a rail size could not be typed at all.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NumberField } from '../../src/renderer/PreferenceControls';

afterEach(() => vi.useRealTimers());

const setup = (value = 72, onCommit = vi.fn()) => {
  render(<NumberField aria-label="Rail size" value={value} min={56} max={120} onCommit={onCommit} />);
  return { field: screen.getByRole('spinbutton', { name: 'Rail size' }) as HTMLInputElement, onCommit };
};

describe('typing a number', () => {
  it('A VALUE BELOW THE MINIMUM ON THE WAY TO A VALID ONE IS NOT CLAMPED MID-WORD', async () => {
    const { field, onCommit } = setup();
    await userEvent.clear(field);
    await userEvent.type(field, '9');
    expect(field.value, 'the 9 of 96 stays a 9').toBe('9');
    await userEvent.type(field, '6');
    expect(field.value).toBe('96');
    await act(() => new Promise((r) => setTimeout(r, 300)));
    expect(onCommit).toHaveBeenCalledWith(96);
    expect(onCommit).not.toHaveBeenCalledWith(56);
  });

  it('leaving the field clamps what is there', async () => {
    const { field, onCommit } = setup();
    await userEvent.clear(field);
    await userEvent.type(field, '500');
    await userEvent.tab();
    expect(onCommit).toHaveBeenLastCalledWith(120);
    expect(field.value).toBe('120');
  });

  it('an emptied field goes back to the current value, not to zero', async () => {
    const { field, onCommit } = setup();
    await userEvent.clear(field);
    await userEvent.tab();
    expect(field.value).toBe('72');
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('Escape puts the current value back', async () => {
    const { field, onCommit } = setup();
    await userEvent.clear(field);
    await userEvent.type(field, '1{Escape}');
    expect(field.value).toBe('72');
    await act(() => new Promise((r) => setTimeout(r, 300)));
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('one commit per settled value, not one per keystroke', async () => {
    const { field, onCommit } = setup();
    await userEvent.clear(field);
    await userEvent.type(field, '100');
    await act(() => new Promise((r) => setTimeout(r, 300)));
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith(100);
  });
});

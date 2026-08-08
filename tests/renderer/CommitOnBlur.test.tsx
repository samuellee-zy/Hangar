// The text field behind every rename and every free-text preference.
//
// It exists so typing costs one command instead of one per character. What it did *not* do was
// survive a state broadcast arriving mid-word: `useEffect(() => setDraft(value), [value])` ran on
// every change to `value`, and `value` comes from ShellState — which is rebroadcast on a sync
// status tick, a rail reorder, any unrelated preference write. The comment above that line claimed
// it only synced "while this field isn't the one being edited". Nothing implemented that.

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CommitOnBlur } from '../../src/renderer/CommitOnBlur';

describe('committing', () => {
  it('sends nothing while typing', async () => {
    const onCommit = vi.fn();
    render(<CommitOnBlur value="" onCommit={onCommit} />);

    await userEvent.type(screen.getByRole('textbox'), 'hello');

    expect(onCommit).not.toHaveBeenCalled();
  });

  it('commits once on blur', async () => {
    const onCommit = vi.fn();
    render(<CommitOnBlur value="" onCommit={onCommit} />);

    await userEvent.type(screen.getByRole('textbox'), 'hello');
    await userEvent.tab();

    expect(onCommit).toHaveBeenCalledExactlyOnceWith('hello');
  });

  it('Enter commits without needing a blur', async () => {
    const onCommit = vi.fn();
    render(<CommitOnBlur value="" onCommit={onCommit} />);

    await userEvent.type(screen.getByRole('textbox'), 'hello{Enter}');

    expect(onCommit).toHaveBeenCalledExactlyOnceWith('hello');
  });

  it('trims, and an unchanged value commits nothing', async () => {
    const onCommit = vi.fn();
    render(<CommitOnBlur value="name" onCommit={onCommit} />);

    await userEvent.type(screen.getByRole('textbox'), '  ');
    await userEvent.tab();

    expect(onCommit).not.toHaveBeenCalled();
    expect(screen.getByRole('textbox')).toHaveValue('name');
  });

  it('a blank value is refused and reverts, rather than committing an empty name', async () => {
    const onCommit = vi.fn();
    render(<CommitOnBlur value="name" onCommit={onCommit} />);

    await userEvent.clear(screen.getByRole('textbox'));
    await userEvent.tab();

    expect(onCommit).not.toHaveBeenCalled();
    expect(screen.getByRole('textbox')).toHaveValue('name');
  });
});

describe('external changes', () => {
  it('A BROADCAST MID-EDIT DOES NOT CLOBBER THE DRAFT', async () => {
    // The regression. Verified by removing the focus guard: the field reverts to "renamed
    // elsewhere" and the user's half-typed word is gone.
    const { rerender } = render(<CommitOnBlur value="original" onCommit={vi.fn()} />);
    const field = screen.getByRole('textbox');

    await userEvent.click(field);
    await userEvent.clear(field);
    await userEvent.type(field, 'half-typed');

    // A ShellState broadcast lands while the field is focused.
    rerender(<CommitOnBlur value="renamed elsewhere" onCommit={vi.fn()} />);

    expect(field).toHaveValue('half-typed');
  });

  it('and the value the user typed is what gets committed', async () => {
    // The clobber was worse than a visual glitch: the reverted draft was then committed on blur,
    // so the edit was silently discarded rather than merely interrupted.
    const onCommit = vi.fn();
    const { rerender } = render(<CommitOnBlur value="original" onCommit={onCommit} />);
    const field = screen.getByRole('textbox');

    await userEvent.click(field);
    await userEvent.clear(field);
    await userEvent.type(field, 'mine');
    rerender(<CommitOnBlur value="theirs" onCommit={onCommit} />);
    await userEvent.tab();

    expect(onCommit).toHaveBeenCalledExactlyOnceWith('mine');
  });

  it('an external change while NOT editing is still followed', async () => {
    // The guard must not go so far that a context-menu rename or an imported config stops showing.
    const { rerender } = render(<CommitOnBlur value="original" onCommit={vi.fn()} />);

    rerender(<CommitOnBlur value="renamed elsewhere" onCommit={vi.fn()} />);

    expect(screen.getByRole('textbox')).toHaveValue('renamed elsewhere');
  });

  it('follows external changes again once the field is blurred', async () => {
    const { rerender } = render(<CommitOnBlur value="original" onCommit={vi.fn()} />);
    const field = screen.getByRole('textbox');

    await userEvent.click(field);
    await userEvent.tab();
    rerender(<CommitOnBlur value="later" onCommit={vi.fn()} />);

    expect(field).toHaveValue('later');
  });

  it('Escape abandons the edit and re-adopts the external value', async () => {
    const onCommit = vi.fn();
    const { rerender } = render(<CommitOnBlur value="original" onCommit={onCommit} />);
    const field = screen.getByRole('textbox');

    await userEvent.click(field);
    await userEvent.clear(field);
    await userEvent.type(field, 'discarded{Escape}');
    rerender(<CommitOnBlur value="external" onCommit={onCommit} />);

    expect(onCommit).not.toHaveBeenCalled();
    expect(field).toHaveValue('external');
  });
});

describe('as a number field', () => {
  // The proxy port and per-service zoom were plain inputs dispatching on change, so each character
  // was an atomic config.json write, a sync reschedule and (for the port) a proxy re-apply.
  it('passes through type and range attributes', () => {
    render(<CommitOnBlur type="number" min={0} max={65535} value="8080" onCommit={vi.fn()} />);

    const field = screen.getByRole('spinbutton');
    expect(field).toHaveValue(8080);
    expect(field).toHaveAttribute('max', '65535');
  });

  it('commits the port once, not once per digit', async () => {
    const onCommit = vi.fn();
    render(<CommitOnBlur type="number" value="0" onCommit={onCommit} />);

    const field = screen.getByRole('spinbutton');
    await userEvent.clear(field);
    await userEvent.type(field, '8080');
    await userEvent.tab();

    expect(onCommit).toHaveBeenCalledExactlyOnceWith('8080');
  });
});

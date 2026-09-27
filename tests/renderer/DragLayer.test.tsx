// The drag layer — the transparent view that covers the panes while a tile is in flight.
//
// It is deliberately the dumbest surface in the app: it reports where the pointer is and draws the
// rectangle main sends back. That makes two things worth pinning. It must draw *nothing* until
// told, because it covers every pane and a stale rectangle from the last drag would appear over
// the wrong one; and it must always offer a way out, because while it is attached it is swallowing
// every click in the window.

import { describe, it, expect, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DragLayer } from '../../src/renderer/DragLayer';
import type { DropHighlight } from '../../src/shared/types';
import { sent, pushHighlight } from './setup';

const RECT = { x: 10, y: 20, width: 300, height: 400 };

describe('drawing', () => {
  it('draws nothing before main says anything', () => {
    const { container } = render(<DragLayer />);
    expect(container).toBeEmptyDOMElement();
  });

  it('outlines the pane a release would replace', async () => {
    const { container } = render(<DragLayer />);
    await act(async () => pushHighlight({ rect: RECT, kind: 'replace' }));

    const target = container.querySelector('.drop-target') as HTMLElement;
    expect(target).toBeTruthy();
    expect(target.style.left).toBe('10px');
    expect(target.style.width).toBe('300px');
    expect(screen.getByText('Open here')).toBeInTheDocument();
  });

  // Main sends a drag's first highlight the moment this view exists. On a slow machine that is
  // before this is listening, and it was lost: nothing drawn until the pointer moved again.
  it('DRAWS A HIGHLIGHT SENT BEFORE IT WAS LISTENING — it asks for the current one on mount', async () => {
    window.hangar.getDragHighlight = vi.fn(async () => ({ rect: RECT, kind: 'replace' as const }));
    render(<DragLayer />);
    expect(await screen.findByText('Open here')).toBeInTheDocument();
  });

  it("an answer that arrives after a newer highlight doesn't replace it", async () => {
    let answer: (h: DropHighlight | null) => void = () => {};
    window.hangar.getDragHighlight = vi.fn(() => new Promise<DropHighlight | null>((resolve) => (answer = resolve)));
    render(<DragLayer />);
    await act(async () => pushHighlight({ rect: RECT, kind: 'new-pane' }));
    await act(async () => answer({ rect: RECT, kind: 'replace' }));
    expect(screen.getByText('Open alongside')).toBeInTheDocument();
  });

  it('says "open alongside", and looks different, when the drop would add a pane', async () => {
    const { container } = render(<DragLayer />);
    await act(async () => pushHighlight({ rect: RECT, kind: 'new-pane' }));
    expect(container.querySelector('.drop-target')).toHaveClass('is-new-pane');
    expect(screen.getByText('Open alongside')).toBeInTheDocument();
  });

  it('erases the indicator when a release would do nothing', async () => {
    // Null is the feedback: over the rail, or over a full layout's gutter, nothing should be
    // outlined at all.
    const { container } = render(<DragLayer />);
    await act(async () => pushHighlight({ rect: RECT, kind: 'replace' }));
    await act(async () => pushHighlight(null));
    expect(container).toBeEmptyDOMElement();
  });
});

describe('reporting', () => {
  it('forwards pointer movement in its own coordinates', async () => {
    render(<DragLayer />);
    await userEvent.pointer({ target: document.body, coords: { clientX: 120, clientY: 90 } });
    expect(sent).toContainEqual({ type: 'drag-tile-to', from: 'content', x: 120, y: 90 });
  });

  it('reports the release, with the position that decides the drop', async () => {
    render(<DragLayer />);
    const user = userEvent.setup();
    await user.pointer([
      { keys: '[MouseLeft>]', target: document.body, coords: { clientX: 120, clientY: 90 } },
      { keys: '[/MouseLeft]', target: document.body, coords: { clientX: 200, clientY: 150 } },
    ]);
    expect(sent).toContainEqual({ type: 'drop-tile', from: 'content', x: 200, y: 150 });
  });

  it('Escape cancels — a drag with no way out is a trap', async () => {
    // This view covers every pane while attached. Committing must not be the only exit.
    render(<DragLayer />);
    await userEvent.keyboard('{Escape}');
    expect(sent).toContainEqual({ type: 'cancel-tile-drag' });
  });

  it('a lost pointer cancels rather than dropping somewhere arbitrary', async () => {
    render(<DragLayer />);
    await act(async () => {
      window.dispatchEvent(new Event('pointercancel'));
    });
    expect(sent).toContainEqual({ type: 'cancel-tile-drag' });
  });

  it('stops listening when unmounted', async () => {
    const { unmount } = render(<DragLayer />);
    unmount();
    await userEvent.keyboard('{Escape}');
    await userEvent.pointer({ target: document.body, coords: { clientX: 5, clientY: 5 } });
    expect(sent).toEqual([]);
  });
});

// Renderer test setup.
//
// `window.hangar` is the preload bridge — the renderer's only way to reach main. In a test there
// is no preload, so every component that touches it would throw on render. This stubs the whole
// surface with spies, which also makes "did this control send exactly one correctly-typed
// command?" directly assertable.

import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { vi, afterEach, beforeEach } from 'vitest';
import type { DropHighlight, ShellState } from '../../src/shared/types';

/** Commands sent during a test, in order. Cleared between tests. */
export const sent: unknown[] = [];

/** Set by a test to control what `getState` resolves with and what `onState` replays. */
export let shellState: ShellState | null = null;
export function setShellState(state: ShellState | null): void {
  shellState = state;
}

/** Subscribers registered via the bridge, so a test can push a new state mid-render. */
const stateSubscribers = new Set<(s: ShellState) => void>();
export function pushState(state: ShellState): void {
  shellState = state;
  for (const fn of stateSubscribers) fn(state);
}

/**
 * Subscribers to `drag:ended`. Main sends this when a drag finished somewhere the rail's renderer
 * couldn't see, so a test needs to be able to play main's part.
 */
const dragEndedSubscribers = new Set<() => void>();
export function pushDragEnded(): void {
  for (const fn of dragEndedSubscribers) fn();
}

/** Subscribers to `drag:highlight`, for the drag layer. */
const highlightSubscribers = new Set<(h: DropHighlight | null) => void>();
export function pushHighlight(highlight: DropHighlight | null): void {
  for (const fn of highlightSubscribers) fn(highlight);
}

// RTL only registers its own auto-cleanup when Vitest runs with `globals: true`, which this
// project doesn't. Without this every render stacks in the same document, so the second test to
// look for a tile finds two and fails with "found multiple elements" — which reads like a
// component bug and isn't one.
afterEach(cleanup);

beforeEach(() => {
  sent.length = 0;
  stateSubscribers.clear();
  dragEndedSubscribers.clear();
  highlightSubscribers.clear();
  shellState = null;

  (window as unknown as { hangar: unknown }).hangar = {
    getState: vi.fn(async () => shellState),
    send: vi.fn((command: unknown) => void sent.push(command)),
    onState: vi.fn((fn: (s: ShellState) => void) => {
      stateSubscribers.add(fn);
      return () => stateSubscribers.delete(fn);
    }),
    getMetrics: vi.fn(async () => ({ processes: 1, residentMb: 100 })),
    getOverlayOpen: vi.fn(async () => null),
    onFindOpened: vi.fn(() => () => {}),
    onFindResult: vi.fn(() => () => {}),
    onOverlayOpen: vi.fn(() => () => {}),
    getDragHighlight: vi.fn(async () => null),
    onDragHighlight: vi.fn((fn: (h: DropHighlight | null) => void) => {
      highlightSubscribers.add(fn);
      return () => highlightSubscribers.delete(fn);
    }),
    onDragEnded: vi.fn((fn: () => void) => {
      dragEndedSubscribers.add(fn);
      return () => dragEndedSubscribers.delete(fn);
    }),
  };
});

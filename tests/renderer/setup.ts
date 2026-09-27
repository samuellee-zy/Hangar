// Renderer test setup.
//
// `window.hangar` is the preload bridge — the renderer's only way to reach main. In a test there
// is no preload, so every component that touches it would throw on render. This stubs the whole
// surface with spies, which also makes "did this control send exactly one correctly-typed
// command?" directly assertable.

import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { vi, afterEach, beforeEach } from 'vitest';
import type { DropHighlight, PaneChromeState, SettingsTarget, ShellState } from '../../src/shared/types';

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

/** Where Settings will be told to open, once, on mount — `settings:get-target`. */
let settingsTarget: SettingsTarget | null = null;
export function setSettingsTarget(target: SettingsTarget | null): void {
  settingsTarget = target;
}

const navigateSubscribers = new Set<(target: SettingsTarget) => void>();
/** Main asking an open Settings window to go somewhere — `settings:navigate`. */
export function pushSettingsNavigate(target: SettingsTarget): void {
  for (const fn of navigateSubscribers) fn(target);
}

/** What a pane bar is told on mount (`pane-chrome:get`), and pushed after (`pane-chrome:state`). */
let paneChrome: PaneChromeState | null = null;
export function setPaneChrome(state: PaneChromeState | null): void {
  paneChrome = state;
}
const paneChromeSubscribers = new Set<(state: PaneChromeState) => void>();
export function pushPaneChrome(state: PaneChromeState): void {
  for (const fn of paneChromeSubscribers) fn(state);
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
  navigateSubscribers.clear();
  paneChromeSubscribers.clear();
  shellState = null;
  settingsTarget = null;
  paneChrome = null;

  (window as unknown as { hangar: unknown }).hangar = {
    getState: vi.fn(async () => shellState),
    send: vi.fn((command: unknown) => void sent.push(command)),
    onState: vi.fn((fn: (s: ShellState) => void) => {
      stateSubscribers.add(fn);
      return () => stateSubscribers.delete(fn);
    }),
    getMetrics: vi.fn(async () => ({ processes: 1, residentMb: 100 })),
    getOverlayOpen: vi.fn(async () => null),
    getSettingsTarget: vi.fn(async () => {
      const target = settingsTarget;
      settingsTarget = null;
      return target;
    }),
    onSettingsNavigate: vi.fn((fn: (target: SettingsTarget) => void) => {
      navigateSubscribers.add(fn);
      return () => navigateSubscribers.delete(fn);
    }),
    onFindOpened: vi.fn(() => () => {}),
    onFindResult: vi.fn(() => () => {}),
    onOverlayOpen: vi.fn(() => () => {}),
    onDragHighlight: vi.fn((fn: (h: DropHighlight | null) => void) => {
      highlightSubscribers.add(fn);
      return () => highlightSubscribers.delete(fn);
    }),
    onDragEnded: vi.fn((fn: () => void) => {
      dragEndedSubscribers.add(fn);
      return () => dragEndedSubscribers.delete(fn);
    }),
    getPaneChrome: vi.fn(async () => paneChrome),
    onPaneChrome: vi.fn((fn: (state: PaneChromeState) => void) => {
      paneChromeSubscribers.add(fn);
      return () => paneChromeSubscribers.delete(fn);
    }),
  };
});

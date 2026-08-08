/// <reference types="vite/client" />
/**
 * The renderer's view of the preload bridge (`src/preload/sidebar.ts`).
 *
 * Keep this in step with what `contextBridge.exposeInMainWorld` actually exposes — it's a hand-
 * written mirror, so a rename on one side and not the other is a runtime `undefined`, not a
 * compile error on the preload side.
 *
 * The surface is deliberately tiny: read state, send a command. Anything richer would let the
 * renderer accumulate its own state, which is the rule the whole architecture rests on.
 */
import type { Command, DropHighlight, OverlayOpen, ShellState } from '@shared/types';

declare global {
  interface Window {
    hangar: {
      getState: () => Promise<ShellState | null>;
      send: (command: Command) => void;
      onState: (fn: (state: ShellState) => void) => () => void;
      getMetrics: () => Promise<{ processes: number; residentMb: number }>;
      getOverlayOpen: () => Promise<OverlayOpen | null>;
      onFindOpened: (fn: () => void) => () => void;
      onFindResult: (fn: (r: { active: number; total: number }) => void) => () => void;
      onOverlayOpen: (fn: (mode: OverlayOpen) => void) => () => void;
      onDragHighlight: (fn: (highlight: DropHighlight | null) => void) => () => void;
      onDragEnded: (fn: () => void) => () => void;
    };
  }
}

export {};

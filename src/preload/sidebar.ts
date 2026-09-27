import { contextBridge, ipcRenderer } from 'electron';
import type {
  Command,
  DropHighlight,
  OverlayOpen,
  PaneChromeState,
  SettingsTarget,
  ShellState,
} from '@shared/types';

// The rail and palette get exactly two verbs: read state, send a command. No direct access to
// services, sessions or windows — that keeps the renderer a pure render target and makes the
// eventual visual redesign a renderer-only change.

contextBridge.exposeInMainWorld('hangar', {
  getState: (): Promise<ShellState | null> => ipcRenderer.invoke('shell:get-state'),
  send: (command: Command): void => ipcRenderer.send('shell:command', command),
  onState: (fn: (state: ShellState) => void): (() => void) => {
    const handler = (_e: unknown, state: ShellState) => fn(state);
    ipcRenderer.on('shell:state', handler);
    return () => ipcRenderer.off('shell:state', handler);
  },
  getMetrics: (): Promise<{ processes: number; residentMb: number }> =>
    ipcRenderer.invoke('app:metrics'),
  getOverlayOpen: (): Promise<OverlayOpen | null> => ipcRenderer.invoke('overlay:get-mode'),
  /** Where Settings was asked to open to, once — and later requests while it is already open. */
  getSettingsTarget: (): Promise<SettingsTarget | null> => ipcRenderer.invoke('settings:get-target'),
  onSettingsNavigate: (fn: (target: SettingsTarget) => void): (() => void) => {
    const handler = (_e: unknown, target: SettingsTarget) => fn(target);
    ipcRenderer.on('settings:navigate', handler);
    return () => ipcRenderer.off('settings:navigate', handler);
  },
  onFindOpened: (fn: () => void): (() => void) => {
    const handler = () => fn();
    ipcRenderer.on('find:opened', handler);
    return () => ipcRenderer.off('find:opened', handler);
  },
  onFindResult: (fn: (r: { active: number; total: number }) => void): (() => void) => {
    const handler = (_e: unknown, r: { active: number; total: number }) => fn(r);
    ipcRenderer.on('find:result', handler);
    return () => ipcRenderer.off('find:result', handler);
  },
  onOverlayOpen: (fn: (mode: OverlayOpen) => void): (() => void) => {
    const handler = (_e: unknown, open: OverlayOpen) => fn(open);
    ipcRenderer.on('overlay:mode', handler);
    return () => ipcRenderer.off('overlay:mode', handler);
  },
  /**
   * What the drag layer should draw, in its own coordinates, or null for nothing. Main decides —
   * see `main/features/drag-layer.ts` for why the deciding can't happen in a renderer.
   */
  onDragHighlight: (fn: (highlight: DropHighlight | null) => void): (() => void) => {
    const handler = (_e: unknown, highlight: DropHighlight | null) => fn(highlight);
    ipcRenderer.on('drag:highlight', handler);
    return () => ipcRenderer.off('drag:highlight', handler);
  },
  /**
   * The rail's cue that a drag it started finished somewhere it can't see. Without it dnd-kit is
   * left holding a lifted tile, because the release happened over another `webContents`.
   */
  onDragEnded: (fn: () => void): (() => void) => {
    const handler = () => fn();
    ipcRenderer.on('drag:ended', handler);
    return () => ipcRenderer.off('drag:ended', handler);
  },
  /** A pane bar's contents — the title bar's, or one pane header's. See main/features/pane-chrome.ts. */
  getPaneChrome: (): Promise<PaneChromeState | null> => ipcRenderer.invoke('pane-chrome:get'),
  onPaneChrome: (fn: (state: PaneChromeState) => void): (() => void) => {
    const handler = (_e: unknown, state: PaneChromeState) => fn(state);
    ipcRenderer.on('pane-chrome:state', handler);
    return () => ipcRenderer.off('pane-chrome:state', handler);
  },
});

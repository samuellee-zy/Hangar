import { contextBridge, ipcRenderer } from 'electron';
import type { Command, OverlayOpen, ShellState } from '../shared/types';

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
});

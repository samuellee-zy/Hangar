import path from 'node:path';
import { BrowserWindow } from 'electron';
import { forwardConsole } from './renderer-url';

/**
 * Settings is a real window rather than another overlay mode, following the macOS Preferences
 * convention. Practically: it can stay open beside the app while you change things and watch the
 * effect, and it stays out of the pane/overlay hit-testing machinery entirely.
 *
 * It reuses the sidebar preload, so there's still exactly one IPC funnel into main — the `Command`
 * union just grew.
 */

let win: BrowserWindow | null = null;

export function openSettingsWindow(register: (wc: Electron.WebContents) => void): void {
  if (win && !win.isDestroyed()) {
    win.focus();
    return;
  }

  win = new BrowserWindow({
    width: 720,
    height: 640,
    minWidth: 560,
    minHeight: 420,
    title: 'Hangar Settings',
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#1b1b1f',
    webPreferences: {
      preload: path.join(__dirname, '../preload/sidebar.cjs'),
      contextIsolation: true,
    },
  });

  forwardConsole(win.webContents, 'settings');

  const devUrl = process.env['ELECTRON_RENDERER_URL'];
  if (devUrl) void win.loadURL(`${devUrl}#settings`);
  else void win.loadFile(path.join(__dirname, '../renderer/index.html'), { hash: 'settings' });

  win.on('closed', () => (win = null));

  // No private channel: Settings uses the same `shell:command` bus and the same `shell:state`
  // broadcast as every other surface. A second channel is what let Settings drift out of date
  // whenever a change came from somewhere else.
  register(win.webContents);
}


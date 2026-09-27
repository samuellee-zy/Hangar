import path from 'node:path';
import { BrowserWindow } from 'electron';
import { loadRoute } from '@main/platform/renderer-url';
import { appBackground } from '@main/platform/native-chrome';
import { safeSend } from '@main/platform/safe-send';
import type { SettingsTarget } from '@shared/types';

/**
 * Settings is a real window rather than another overlay mode, following the macOS Preferences
 * convention. Practically: it can stay open beside the app while you change things and watch the
 * effect, and it stays out of the pane/overlay hit-testing machinery entirely.
 *
 * It reuses the sidebar preload, so there's still exactly one IPC funnel into main — the `Command`
 * union just grew.
 */

let win: BrowserWindow | null = null;

/**
 * Where a window still loading should open to. It asks on mount (`settings:get-target`) — a message
 * sent before its renderer subscribed would simply be lost, the overlay's old first-open bug.
 */
let pendingTarget: SettingsTarget | null = null;

export function takeSettingsTarget(): SettingsTarget | null {
  const target = pendingTarget;
  pendingTarget = null;
  return target;
}

export function openSettingsWindow(
  register: (wc: Electron.WebContents) => void,
  target: SettingsTarget | null = null,
): void {
  if (win && !win.isDestroyed()) {
    win.focus();
    if (target) safeSend(win.webContents, 'settings:navigate', target);
    return;
  }
  pendingTarget = target;

  win = new BrowserWindow({
    width: 880,
    height: 640,
    minWidth: 680,
    minHeight: 420,
    title: 'Hangar Settings',
    titleBarStyle: 'hiddenInset',
    backgroundColor: appBackground(),
    webPreferences: {
      preload: path.join(__dirname, '../preload/sidebar.cjs'),
      contextIsolation: true,
      // Explicit rather than left to the default: these views hold the app's bridge (decisions #97).
      sandbox: true,
    },
  });

  // ⌘W, on this window's own contents.
  //
  // It used to come from the menu's registered accelerator, which dispatched `close-pane` at the
  // *main* window — so closing Settings from the keyboard closed a pane behind it instead. The menu
  // no longer registers anything (see boot/menu.ts), and the shell keymap is deliberately not
  // attached here: every one of its actions targets panes this window doesn't have.
  const closer = win;
  win.webContents.on('before-input-event', (event, input) => {
    const primary = process.platform === 'darwin' ? input.meta : input.control;
    if (input.type !== 'keyDown' || !primary || input.alt || input.shift) return;
    if (input.key.toLowerCase() !== 'w') return;
    event.preventDefault();
    if (!closer.isDestroyed()) closer.close();
  });

  // Through `loadRoute` like every other internal screen, so it gets the same lockdown: it holds
  // the same bridge, and loading itself directly is how it came to be the one screen without it.
  loadRoute(win.webContents, 'settings');

  win.on('closed', () => (win = null));

  // No private channel: Settings uses the same `shell:command` bus and the same `shell:state`
  // broadcast as every other surface. A second channel is what let Settings drift out of date
  // whenever a change came from somewhere else.
  register(win.webContents);
}


/**
 * Closes Settings if it's open. Called from `AppWindow.dispose()`.
 *
 * Without this, `openSettingsWindow` early-returns on the still-open window from the *previous*
 * AppWindow — so it never registers against the new one and renders a frozen snapshot of state
 * that stopped updating when the old window died.
 */
export function closeSettingsWindow(): void {
  if (win && !win.isDestroyed()) win.close();
  win = null;
}

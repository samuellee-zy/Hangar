import { Menu, app, type MenuItemConstructorOptions } from 'electron';
import type { Command } from '@shared/types';

/**
 * Owning the menu is not cosmetic — it's the only way to own the keys.
 *
 * Electron installs a default menu when you don't, and its Window submenu binds ⌘W to the `close`
 * role. That accelerator fires at the app level regardless of what `before-input-event` does, so
 * ⌘W closed the whole window even when the intent was "close this pane". Replacing the menu is
 * what makes our binding authoritative.
 *
 * It also makes the shortcuts discoverable, which they weren't at all before.
 */
export function installMenu(dispatch: (command: Command) => boolean): void {
  const send = (command: Command) => () => dispatch(command);

  const template: MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: send({ type: 'open-settings' }) },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'File',
      submenu: [
        { label: 'Add connection…', accelerator: 'CmdOrCtrl+N', click: send({ type: 'open-connections' }) },
        { type: 'separator' },
        { label: 'Print…', accelerator: 'CmdOrCtrl+P', click: send({ type: 'print' }) },
        { type: 'separator' },
        { label: 'Export configuration…', click: send({ type: 'export-config' }) },
        { label: 'Import configuration…', click: send({ type: 'import-config' }) },
        { type: 'separator' },
        // Deliberately NOT { role: 'close' } — that's the binding that was stealing ⌘W.
        {
          label: 'Close pane',
          accelerator: 'CmdOrCtrl+W',
          click: send({ type: 'close-pane', paneId: '#focused' }),
        },
      ],
    },
    // Roles, not custom handlers: without an Edit menu, ⌘C/⌘V/⌘A don't work inside the web apps.
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'pasteAndMatchStyle' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { label: 'Command palette', accelerator: 'CmdOrCtrl+K', click: send({ type: 'open-palette' }) },
        { label: 'Find in page…', accelerator: 'CmdOrCtrl+F', click: send({ type: 'open-find' }) },
        { type: 'separator' },
        { label: 'Zoom in', accelerator: 'CmdOrCtrl+=', click: send({ type: 'zoom', direction: 'in' }) },
        { label: 'Zoom out', accelerator: 'CmdOrCtrl+-', click: send({ type: 'zoom', direction: 'out' }) },
        {
          label: 'Actual size',
          accelerator: 'CmdOrCtrl+0',
          click: send({ type: 'zoom', direction: 'reset' }),
        },
        { type: 'separator' },
        { label: 'Split pane', accelerator: 'CmdOrCtrl+\\', click: send({ type: 'split' }) },
        {
          label: 'Focus previous pane',
          accelerator: 'CmdOrCtrl+Alt+Left',
          click: send({ type: 'cycle-pane', delta: -1 }),
        },
        {
          label: 'Focus next pane',
          accelerator: 'CmdOrCtrl+Alt+Right',
          click: send({ type: 'cycle-pane', delta: 1 }),
        },
        { type: 'separator' },
        { label: 'Back', accelerator: 'CmdOrCtrl+[', click: send({ type: 'navigate', direction: 'back' }) },
        {
          label: 'Forward',
          accelerator: 'CmdOrCtrl+]',
          click: send({ type: 'navigate', direction: 'forward' }),
        },
        { type: 'separator' },
        {
          label: 'Sleep background services',
          click: send({ type: 'sleep-others' }),
        },
        { type: 'separator' },
        { role: 'toggleDevTools' },
      ],
    },
    { label: 'Window', submenu: [{ role: 'minimize' }, { role: 'zoom' }, { role: 'front' }] },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

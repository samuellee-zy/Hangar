import { Menu, Tray, app, nativeImage } from 'electron';
import type { Command, ShellState } from '../shared/types';

/**
 * Menu-bar presence: unread count, a jump list, DND, and a way back to the window when it's hidden.
 *
 * The tray is what makes "close to tray" and "start hidden" safe to offer — without it, either
 * setting could leave the app running with no way to reach it.
 */

let tray: Tray | null = null;

/** A template image so macOS inverts it correctly in light and dark menu bars. */
function icon(): Electron.NativeImage {
  // 16pt rounded square outline, drawn rather than shipped as an asset so there's no file to keep
  // in sync with the app icon.
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16">
    <rect x="2" y="2" width="12" height="12" rx="3" fill="none" stroke="black" stroke-width="1.6"/>
    <rect x="5" y="5" width="6" height="6" rx="1.5" fill="black"/>
  </svg>`;
  const image = nativeImage.createFromDataURL(
    `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`
  );
  image.setTemplateImage(true);
  return image;
}

export function ensureTray(getState: () => ShellState | null, dispatch: (c: Command) => boolean): void {
  if (tray) return;
  tray = new Tray(icon());
  tray.setToolTip('Hangar');
  // Clicking the icon itself should show the window; the menu is for everything else.
  tray.on('click', () => dispatch({ type: 'show-window' }));
  refreshTray(getState(), dispatch);
}

export function destroyTray(): void {
  tray?.destroy();
  tray = null;
  // Otherwise a tray re-enabled later would skip its first rebuild and show an empty menu.
  lastSignature = '';
}

/**
 * The menu is rebuilt only when its contents change. `sync()` fires on every load event and every
 * 30-second hibernation sweep, and rebuilding a native menu each time is pure waste.
 */
let lastSignature = '';

export function refreshTray(state: ShellState | null, dispatch: (c: Command) => boolean): void {
  if (!tray || !state) return;

  const signature = JSON.stringify([
    state.services.map((s) => [s.id, s.name, s.unread]),
    state.preferences.notifications.dnd,
  ]);
  if (signature === lastSignature) return;
  lastSignature = signature;

  const unread = state.services.reduce((sum, s) => sum + s.unread, 0);
  // Text beside the icon, not a badge — macOS trays have no badge API.
  tray.setTitle(unread > 0 ? String(unread) : '');
  tray.setToolTip(unread > 0 ? `Hangar — ${unread} unread` : 'Hangar');

  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Show Hangar', click: () => dispatch({ type: 'show-window' }) },
      { type: 'separator' },
      ...state.services.slice(0, 12).map((svc) => ({
        label: svc.unread > 0 ? `${svc.name} (${svc.unread})` : svc.name,
        click: () => {
          dispatch({ type: 'show-window' });
          dispatch({ type: 'focus-service', serviceId: svc.id });
        },
      })),
      { type: 'separator' },
      {
        label: 'Do not disturb',
        type: 'checkbox',
        checked: state.preferences.notifications.dnd,
        click: () =>
          dispatch({
            type: 'set-preference',
            path: 'notifications.dnd',
            value: !state.preferences.notifications.dnd,
          }),
      },
      {
        label: 'Sleep background services',
        click: () => dispatch({ type: 'sleep-others' }),
      },
      { type: 'separator' },
      { label: 'Quit Hangar', click: () => app.quit() },
    ])
  );
}

import { Menu, Tray, app, nativeImage } from 'electron';
import { HOUR_MS, tomorrowMorning } from '@core/notify/policy';
import { TRAY_GLYPH_POINTS, trayGlyphBitmap } from '@main/features/tray-glyph';
import type { Command, ShellState } from '@shared/types';

/**
 * Menu-bar presence: unread count, a jump list, DND, and a way back to the window when it's hidden.
 *
 * The tray is what makes "close to tray" safe to offer — without it, the setting could leave the
 * app running with no way to reach it. It is not the only way back: the Dock icon, the Window
 * menu and the Dock menu all show the window too (decision #96).
 */

let tray: Tray | null = null;

/**
 * A template image so macOS inverts it correctly in light and dark menu bars.
 *
 * Both resolutions, or a Retina menu bar upscales the 1x and the glyph goes soft. See tray-glyph.ts
 * for why this is pixels and not the SVG it used to be.
 */
function icon(): Electron.NativeImage {
  const size = TRAY_GLYPH_POINTS;
  const image = nativeImage.createFromBitmap(trayGlyphBitmap(1), { width: size, height: size });
  image.addRepresentation({
    scaleFactor: 2,
    width: size * 2,
    height: size * 2,
    buffer: nativeImage.createFromBitmap(trayGlyphBitmap(2), { width: size * 2, height: size * 2 }).toPNG(),
  });
  image.setTemplateImage(true);
  // Loud, because the failure it guards is silent: an empty image is a tray nobody can see.
  if (image.isEmpty()) console.warn('[tray] icon image is empty — the menu-bar item will be invisible');
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

/** How many services the menu lists before the rest go under More. */
const TRAY_SERVICES = 12;

export function refreshTray(state: ShellState | null, dispatch: (c: Command) => boolean): void {
  if (!tray || !state) return;

  // Every workspace, not the active one. The Dock badge counts them all, and a tray that counted
  // only the workspace on screen disagreed with it — and could not reach a service anywhere else.
  // `focus-service` switches workspace for one that lives elsewhere.
  const services = state.allServices;
  const signature = JSON.stringify([
    services.map((s) => [s.id, s.name, s.unread]),
    state.preferences.notifications.dnd,
    state.preferences.notifications.dndUntil,
    (state.recentNotifications ?? []).map((n) => n.at),
    (state.downloads ?? []).map((d) => [d.id, d.state, d.received]),
  ]);
  if (signature === lastSignature) return;
  lastSignature = signature;

  const unread = services.reduce((sum, s) => sum + s.unread, 0);
  const serviceItem = (svc: (typeof services)[number]): Electron.MenuItemConstructorOptions => ({
    label: svc.unread > 0 ? `${svc.name} (${svc.unread})` : svc.name,
    click: () => {
      dispatch({ type: 'show-window' });
      dispatch({ type: 'focus-service', serviceId: svc.id });
    },
  });
  // Text beside the icon, not a badge — macOS trays have no badge API.
  tray.setTitle(unread > 0 ? String(unread) : '');
  tray.setToolTip(unread > 0 ? `Hangar — ${unread} unread` : 'Hangar');

  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Show Hangar', click: () => dispatch({ type: 'show-window' }) },
      {
        label: 'Add connection…',
        click: () => {
          dispatch({ type: 'show-window' });
          dispatch({ type: 'open-connections' });
        },
      },
      { label: 'Settings…', click: () => dispatch({ type: 'open-settings' }) },
      { type: 'separator' },
      ...services.slice(0, TRAY_SERVICES).map(serviceItem),
      // The rest, rather than nothing: the list stopped at twelve, so a thirteenth service had no
      // way in from here at all.
      ...(services.length > TRAY_SERVICES
        ? [{ label: 'More', submenu: services.slice(TRAY_SERVICES).map(serviceItem) }]
        : []),
      { type: 'separator' },
      ...(() => {
        const extras = [...recentMenu(state, dispatch), ...downloadsMenu(state, dispatch)];
        return extras.length ? [...extras, { type: 'separator' as const }] : [];
      })(),
      dndMenu(state, dispatch),
      {
        label: 'Sleep background services',
        click: () => dispatch({ type: 'sleep-others' }),
      },
      { type: 'separator' },
      { label: 'Quit Hangar', click: () => app.quit() },
    ])
  );
}

/** "until 14:30", or "until tomorrow 09:00" when it runs past midnight. */
export function untilLabel(until: number, now = Date.now()): string {
  const at = new Date(until);
  const time = at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return new Date(now).toDateString() === at.toDateString() ? `until ${time}` : `until tomorrow ${time}`;
}

/**
 * Do Not Disturb, with a time limit. It was a checkbox — on until you remembered to turn it off —
 * while the config had carried an unused `dndUntil` all along.
 */
export function dndMenu(state: ShellState, dispatch: (c: Command) => boolean): Electron.MenuItemConstructorOptions {
  const { dnd, dndUntil } = state.preferences.notifications;
  const set = (on: boolean, until: number | null) => () => dispatch({ type: 'set-dnd', on, until });
  return {
    label: dnd ? `Do not disturb — ${dndUntil ? untilLabel(dndUntil) : 'on'}` : 'Do not disturb',
    // The state as one radio group, the timed choices as plain items below it. Radio and plain items
    // were interleaved, so a timed DND had nothing checked at all and "Off" looked unselected for
    // no visible reason.
    submenu: [
      { label: 'Off', type: 'radio', checked: !dnd, click: set(false, null) },
      ...(dnd && dndUntil
        ? [{ label: `On ${untilLabel(dndUntil)}`, type: 'radio' as const, checked: true, enabled: false }]
        : []),
      { label: 'On until I turn it off', type: 'radio', checked: dnd && dndUntil === null, click: set(true, null) },
      { type: 'separator' },
      { label: 'For 1 hour', click: () => dispatch({ type: 'set-dnd', on: true, until: Date.now() + HOUR_MS }) },
      { label: 'Until tomorrow', click: () => dispatch({ type: 'set-dnd', on: true, until: tomorrowMorning(Date.now()) }) },
    ],
  };
}

const clip = (text: string, max = 48) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/**
 * The last few notifications, so a banner you missed — or one DND held back — can still be found
 * and followed to the service that sent it.
 */
function recentMenu(state: ShellState, dispatch: (c: Command) => boolean): Electron.MenuItemConstructorOptions[] {
  const recent = state.recentNotifications ?? [];
  if (recent.length === 0) return [];
  const nameOf = (id: string) => state.allServices.find((s) => s.id === id)?.name ?? '';
  return [
    {
      label: 'Recent notifications',
      submenu: recent.slice(0, 10).map((n) => ({
        label: clip(`${nameOf(n.serviceId)}: ${n.title}`),
        sublabel: n.body ? clip(n.body, 60) : undefined,
        click: () => {
          dispatch({ type: 'show-window' });
          dispatch({ type: 'focus-service', serviceId: n.serviceId });
        },
      })),
    },
  ];
}

/** Recent downloads, with progress, each a way back to the file. */
function downloadsMenu(state: ShellState, dispatch: (c: Command) => boolean): Electron.MenuItemConstructorOptions[] {
  const downloads = state.downloads ?? [];
  if (downloads.length === 0) return [];
  const status = (d: NonNullable<ShellState['downloads']>[number]) => {
    if (d.state === 'completed') return '';
    if (d.state === 'progressing') return d.total ? ` — ${Math.floor((d.received / d.total) * 100)}%` : ' — downloading';
    return ` — ${d.state}`;
  };
  return [
    {
      label: 'Downloads',
      submenu: downloads.map((d) => ({
        label: clip(`${d.name}${status(d)}`),
        enabled: d.state === 'completed',
        click: () => dispatch({ type: 'reveal-download', id: d.id }),
      })),
    },
  ];
}

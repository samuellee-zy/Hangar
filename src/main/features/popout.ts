import { BrowserWindow } from 'electron';
import { installWebContextMenu } from '@main/features/context-menu';
import { attachNavigationGuards, partitionFor } from '@main/platform/session';
import { appBackground } from '@main/platform/native-chrome';
import type { ServiceInstance } from '@shared/types';

/**
 * A service in a window of its own — a call you want beside something else, a doc on a second
 * screen.
 *
 * A separate web page in the same session, so it is already signed in, with the same allowlist,
 * permissions and context menu as the pane. Deliberately *without* the service preload: that
 * preload routes notifications and unread through the pane, and a second copy reporting them would
 * count every message twice. The window's own page notifies natively instead.
 *
 * One per service; asking again brings the existing one forward.
 */
const open = new Map<string, BrowserWindow>();

export function popOut(svc: ServiceInstance, url: string): void {
  const existing = open.get(svc.id);
  if (existing && !existing.isDestroyed()) {
    existing.show();
    existing.focus();
    return;
  }

  const partition = partitionFor(svc);
  const win = new BrowserWindow({
    width: 1100,
    height: 800,
    title: svc.name,
    backgroundColor: appBackground(),
    webPreferences: {
      partition,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: true,
      safeDialogs: true,
    },
  });
  open.set(svc.id, win);
  win.on('closed', () => open.delete(svc.id));

  attachNavigationGuards(win.webContents, svc, partition);
  installWebContextMenu(win.webContents, win);
  // The page's own title, like a browser tab — but always saying which service it is.
  win.webContents.on('page-title-updated', (event, title) => {
    event.preventDefault();
    win.setTitle(title && title !== svc.name ? `${title} — ${svc.name}` : svc.name);
  });
  win.loadURL(url).catch((err: unknown) => console.warn(`[popout] ${svc.name}: ${String(err)}`));
}

/** Each popped-out window's page, by service — for asking before a quit ends a call in one. */
export function popOutContents(): Array<[serviceId: string, contents: Electron.WebContents]> {
  return [...open].filter(([, win]) => !win.isDestroyed()).map(([id, win]) => [id, win.webContents]);
}

/** Closes every popped-out window. For teardown. */
export function closePopOuts(): void {
  for (const win of open.values()) if (!win.isDestroyed()) win.close();
  open.clear();
}

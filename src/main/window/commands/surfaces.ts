import { loadConfig } from '@main/platform/config';
import {
  showFolderMenu,
  showRailMenu,
  showServiceMenu,
  showWorkspaceMenu,
} from '@main/features/context-menu';
import { openSettingsWindow } from '@main/features/settings-window';
import { findFolder, flattenServiceIds } from '@core/workspace/folders';
import { resolveUrl } from '@shared/catalog';
import type { Command, OverlayMode } from '@shared/types';
import type { CommandTable, ShellContext } from '@main/window/commands/context';

/**
 * A toggle against itself — the chord that opens an overlay also shuts it — while any other
 * overlay open is replaced: ⌘K while the picker is open switches to the palette.
 */
function toggleOverlay(shell: ShellContext, mode: OverlayMode): void {
  if (shell.overlay.currentMode === mode) {
    shell.overlay.close();
    shell.focusActivePane();
  } else {
    shell.openOverlay(mode);
  }
}

/** The app's own screens — overlays, Settings, the window — its menus, and dragging a tile. */
export const surfaceCommands: CommandTable = {
  'open-palette': (_command, shell) => toggleOverlay(shell, 'palette'),
  'open-shortcuts': (_command, shell) => toggleOverlay(shell, 'shortcuts'),
  'open-activity': (_command, shell) => toggleOverlay(shell, 'activity'),
  'open-connections': (_command, shell) => shell.openOverlay('connections'),

  'close-overlay': (_command, shell) => {
    // Reports false when nothing was open, so Escape falls through to the page.
    const wasOpen = shell.overlay.isOpen;
    if (wasOpen) {
      shell.overlay.close();
      shell.focusActivePane();
    }
    return wasOpen;
  },

  'open-settings': (command, shell) =>
    openSettingsWindow(
      (wc) => shell.registerConsumer(wc),
      command.section || command.serviceId
        ? { section: command.section, serviceId: command.serviceId }
        : null,
    ),
  'show-window': (_command, shell) => shell.showWindow(),
  'toggle-rail': (_command, shell) => shell.toggleRail(),

  'show-rail-menu': (_command, shell) => showRailMenu(shell.win, (c) => shell.dispatch(c)),

  'show-folder-menu': (command, shell) => {
    const ws = shell.activeWorkspace(loadConfig().activeWorkspaceId);
    const folder = ws && findFolder(ws, command.folderId);
    if (folder) showFolderMenu(shell.win, folder, (c: Command) => shell.dispatch(c));
  },

  'show-service-menu': (command, shell) => {
    const config = loadConfig();
    const svc = config.services.find((s) => s.id === command.serviceId);
    if (!svc) return;
    const workspace = shell.activeWorkspace(config.activeWorkspaceId);
    const folders = (workspace?.items ?? []).filter((i) => i.kind === 'folder');
    showServiceMenu(
      shell.win,
      svc,
      {
        paneId: shell.layout.panes.find((pane) => pane.serviceId === svc.id)?.id ?? null,
        isSleeping: !shell.services.has(svc.id),
        folders: folders.map((f) => ({ id: f.id, name: f.name })),
        currentFolderId: folders.find((f) => f.serviceIds.includes(svc.id))?.id ?? null,
        unread: shell.unreadOf(svc.id),
        // Where it is now, not where it started: the address worth copying is the page on screen.
        currentUrl: shell.contentsForService(svc.id)?.getURL() || resolveUrl(svc),
        otherWorkspaces: config.workspaces
          .filter((w) => w.id !== config.activeWorkspaceId)
          .map((w) => ({ id: w.id, name: w.name })),
      },
      (c) => shell.dispatch(c),
    );
  },

  'show-workspace-menu': (_command, shell) => {
    const config = loadConfig();
    showWorkspaceMenu(
      shell.win,
      config.workspaces.map((w) => ({
        id: w.id,
        name: w.name,
        active: w.id === config.activeWorkspaceId,
        unread: flattenServiceIds(w).reduce((sum, id) => sum + shell.unreadOf(id), 0),
      })),
      (c) => shell.dispatch(c),
    );
  },

  'begin-tile-drag': (command, shell) => shell.beginTileDrag(command.serviceId),
  'begin-pane-drag': (command, shell) => shell.beginPaneDrag(command.paneId),
  'drag-tile-to': (command, shell) => shell.moveTileDrag(command.from, command.x, command.y),
  'drop-tile': (command, shell) => shell.dropTile(command.from, command.x, command.y),
  'cancel-tile-drag': (_command, shell) => shell.endTileDrag(),
};

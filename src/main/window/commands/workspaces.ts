import { loadConfig, updateConfig, updateConfigReturning } from '@main/platform/config';
import { createFolder, deleteFolder, findFolder, moveItemTo, moveToFolder } from '@core/workspace/folders';
import {
  createWorkspace,
  deleteWorkspace,
  renameWorkspace,
  reorderWorkspaces,
} from '@core/workspace/workspaces';
import type { CommandTable } from '@main/window/commands/context';

/** Workspaces, and the rail tree inside one: order, folders, and which folder a service is in. */
export const workspaceCommands: CommandTable = {
  'set-workspace': (command, shell) => {
    // Save the outgoing workspace's arrangement before switching, so ⌘⌥1/⌘⌥2 round-trips.
    shell.saveLayout();
    updateConfig((c) => {
      c.activeWorkspaceId = command.workspaceId;
    });
    shell.overlay.close();
    shell.rebuildPanes();
    shell.relayout();
  },

  'create-workspace': (command, shell) => {
    const id = updateConfigReturning((c) => createWorkspace(c, command.name));
    shell.dispatch({ type: 'set-workspace', workspaceId: id });
  },

  'rename-workspace': (command, shell) => {
    updateConfig((c) => renameWorkspace(c, command.workspaceId, command.name));
    shell.sync();
  },

  'delete-workspace': (command, shell) => {
    const result = updateConfigReturning((c) => deleteWorkspace(c, command.workspaceId));
    if (!result.deleted) return;
    if (result.rehomed.length) {
      console.log(`[workspace] rehomed ${result.rehomed.length} orphaned service(s)`);
    }
    // The active workspace may have changed under us; rebuild from whatever it is now.
    shell.rebuildPanes();
    shell.relayout();
  },

  'reorder-workspaces': (command, shell) => {
    updateConfig((c) => reorderWorkspaces(c, command.workspaceIds));
    shell.sync();
  },

  'move-item': (command, shell) =>
    shell.mutateWorkspace((w) => moveItemTo(w, command.activeId, command.overId)),

  'create-folder': (command, shell) => {
    let folderId = '';
    shell.mutateWorkspace((w) => {
      folderId = createFolder(w, command.name, command.serviceIds);
    });
    // Straight into naming it, where the rail can edit in place. Every folder used to stay
    // "New folder": the name was a placeholder and nothing afterwards asked for a real one.
    // Not elsewhere — an ordinary rail would answer by opening Settings, every time.
    const { compactRail, railPosition } = loadConfig().preferences.appearance;
    const vertical = railPosition === 'left' || railPosition === 'right';
    if (folderId && compactRail && vertical) shell.dispatch({ type: 'begin-rename-folder', folderId });
  },

  'rename-folder': (command, shell) => {
    // Every workspace, not just the active one: Settings lists the folders of all of them, and
    // an id names exactly one folder wherever it lives.
    const name = command.name.trim();
    if (!name) return;
    updateConfig((c) => {
      for (const w of c.workspaces) {
        const folder = findFolder(w, command.folderId);
        if (folder) folder.name = name;
      }
    });
    shell.sync();
  },

  'delete-folder': (command, shell) => shell.mutateWorkspace((w) => deleteFolder(w, command.folderId)),

  'toggle-folder': (command, shell) =>
    shell.mutateWorkspace((w) => {
      const folder = findFolder(w, command.folderId);
      if (folder) folder.collapsed = !folder.collapsed;
    }),

  'move-to-folder': (command, shell) =>
    shell.mutateWorkspace((w) => moveToFolder(w, command.serviceId, command.folderId)),
};

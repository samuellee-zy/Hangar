import fs from 'node:fs';
import { shell as electronShell } from 'electron';
import { configFilePath, quarantinedConfigs } from '@main/platform/config';
import { LOG_FILE } from '@main/platform/log-file';
import { downloadPath } from '@main/platform/system';
import { exportConfig, importConfig } from '@main/features/transfer';
import type { CommandTable } from '@main/window/commands/context';

/** Files on disk and in the repo: sync, export and import, cleanup, and showing things in Finder. */
export const dataCommands: CommandTable = {
  'sync-now': (_command, shell) => {
    void shell.configSync.reconcile();
  },

  'resolve-sync': (command, shell) => {
    void shell.configSync.resolve(command.winner);
  },

  'export-config': (_command, shell) => {
    exportConfig(shell.win).catch((err: unknown) => console.error('[transfer] export failed:', err));
  },

  'import-config': (_command, shell) => {
    importConfig(shell.win, () => {
      // A fresh config means every view is stale — rebuild from scratch.
      for (const [serviceId] of [...shell.services.all()]) shell.sleep(serviceId);
      shell.rebuildPanes();
      shell.relayout();
    }).catch((err: unknown) => console.error('[transfer] import failed:', err));
  },

  'purge-orphan-partitions': (_command, shell) => shell.purgeOrphanPartitions(),

  'reveal-path': (command) => {
    // Restricted to paths we actually surfaced. The renderer is a separate process and this is
    // an IPC boundary — an arbitrary path from a message would be a way to probe the disk.
    if (quarantinedConfigs().includes(command.path)) electronShell.showItemInFolder(command.path);
  },

  reveal: (command) => {
    if (command.what === 'config') electronShell.showItemInFolder(configFilePath());
    else if (fs.existsSync(LOG_FILE)) electronShell.showItemInFolder(LOG_FILE);
  },

  'reveal-download': (command) => {
    const saved = downloadPath(command.id);
    if (saved && fs.existsSync(saved)) electronShell.showItemInFolder(saved);
  },
};

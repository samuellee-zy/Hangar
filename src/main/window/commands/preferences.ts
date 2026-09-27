import { app, dialog, nativeTheme } from 'electron';
import { loadConfig, updateConfig } from '@main/platform/config';
import { resetPreferences, setPreference } from '@core/config/preferences';
import { rebind } from '@core/keyboard/keymap';
import { setDnd } from '@core/notify/policy';
import type { CommandTable } from '@main/window/commands/context';

/** Preferences, key bindings, Do Not Disturb, and the settings that reach outside the app. */
export const preferenceCommands: CommandTable = {
  'set-preference': (command, shell) => {
    const before = loadConfig().preferences.appearance.theme;
    updateConfig((c) => {
      // Rejected silently when the path is unknown or the type is wrong — see setPreference.
      if (!setPreference(c.preferences, command.path, command.value)) {
        console.warn(`[preferences] rejected ${command.path}`);
      }
    });
    const after = loadConfig().preferences.appearance.theme;
    // Renderers read `prefers-color-scheme`, which Electron drives from themeSource.
    if (after !== before) nativeTheme.themeSource = after;
    shell.applyPreferenceEffect(command.path);
    // Appearance changes affect pane geometry, so relayout before telling anyone.
    shell.relayout();
  },

  'reset-preferences': (command, shell) => {
    // Per section or wholesale. Until now a bad rail position or zoom was only recoverable by
    // hand-editing config.json — which for a setting that can make the window unusable is not
    // a recovery path at all.
    updateConfig((c) => {
      c.preferences = resetPreferences(c.preferences, command.section);
    });
    shell.applyAllPreferenceEffects();
    shell.relayout();
    shell.sync();
  },

  rebind: (command, shell) => {
    // Revalidated here, not trusted from the renderer: `rebind` refuses an unknown action or an
    // unbindable chord, and returns the map unchanged rather than throwing.
    updateConfig((c) => {
      c.preferences.keyboard.bindings = rebind(c.preferences.keyboard.bindings, command.actionId, command.chord);
    });
    // `sync()` redraws the menu — see `refreshMenuIfRebound`, which is what makes an imported
    // or synced config update it too.
    shell.sync();
  },

  'set-dnd': (command, shell) => {
    updateConfig((c) => setDnd(c.preferences.notifications, command.on, command.until));
    shell.sync();
  },

  'choose-folder': (command, shell) => {
    const purpose = command.purpose;
    dialog
      .showOpenDialog({
        title: purpose === 'sync' ? 'Choose the sync repository' : 'Choose a downloads folder',
        properties: ['openDirectory', 'createDirectory'],
      })
      .then(({ canceled, filePaths }) => {
        const folder = filePaths[0];
        if (canceled || !folder) return;
        shell.dispatch({
          type: 'set-preference',
          path: purpose === 'sync' ? 'sync.repoPath' : 'downloads.folder',
          value: folder,
        });
      })
      .catch((err: unknown) => console.error('[settings] folder picker failed:', err));
  },

  'make-default-mail-app': (_command, shell) => {
    // Packaged only: unpackaged, this would register the bare Electron binary as your mail app.
    if (app.isPackaged && !app.setAsDefaultProtocolClient('mailto')) {
      console.warn('[mailto] macOS did not accept Hangar as the default email app');
    }
    shell.forgetDefaultMailApp();
    shell.sync();
  },
};

import { dialog, type BaseWindow } from 'electron';
import fs from 'node:fs';
import { loadConfig, saveConfig } from '@main/platform/config';
import { migrateConfig } from '@core/config/migrate';
import type { Config } from '@shared/types';

/**
 * Export and import `config.json`.
 *
 * There is no cloud sync by design, so backup has to be something you can actually do. What is
 * *not* exported matters as much as what is:
 *
 *  - **Cookies and sessions stay put.** Partitions live on disk under `Partitions/` and aren't
 *    portable; an export that looked like a full backup but silently dropped every login would be
 *    worse than no export at all. The file says so in a `_note` field.
 *  - Accounts are exported as labels and ids only — they hold no credentials, just the partition
 *    name that points at a jar on this machine.
 */

const NOTE =
  'Hangar configuration. Sessions and cookies are NOT included — they live in the Partitions ' +
  'folder alongside this config and are specific to this machine. After importing you will need ' +
  'to sign in again.';

export async function exportConfig(window: BaseWindow): Promise<void> {
  const { canceled, filePath } = await dialog.showSaveDialog(window as never, {
    title: 'Export Hangar configuration',
    defaultPath: 'hangar-config.json',
    filters: [{ name: 'JSON', extensions: ['json'] }],
  });
  if (canceled || !filePath) return;

  const config = loadConfig();
  const { notifications } = config.preferences;
  fs.writeFileSync(
    filePath,
    // Not `pushRegistrations`: each holds the private keys that decrypt this machine's pushes, and
    // is bound to this one receiver — useless on another Mac, and not something to leave in a file
    // in Downloads. Not the Firebase credential either, for the second of those reasons; sync keeps
    // it local too. Custom scripts *are* kept: this is your own backup, and they are your own code —
    // it's the importing side that has to be careful with them.
    JSON.stringify(
      {
        _note: NOTE,
        ...config,
        window: undefined,
        pushRegistrations: undefined,
        preferences: { ...config.preferences, notifications: { ...notifications, firebase: undefined } },
      },
      null,
      2
    )
  );
  console.log(`[transfer] exported to ${filePath}`);
}

export async function importConfig(window: BaseWindow, onLoaded: () => void): Promise<void> {
  const { canceled, filePaths } = await dialog.showOpenDialog(window as never, {
    title: 'Import Hangar configuration',
    properties: ['openFile'],
    filters: [{ name: 'JSON', extensions: ['json'] }],
  });
  const file = filePaths[0];
  if (canceled || !file) return;

  let parsed: Partial<Config>;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<Config>;
  } catch {
    await dialog.showMessageBox(window as never, {
      type: 'error',
      message: "That file isn't valid JSON.",
    });
    return;
  }

  if (!Array.isArray(parsed.services) || !Array.isArray(parsed.workspaces)) {
    await dialog.showMessageBox(window as never, {
      type: 'error',
      message: "That doesn't look like a Hangar configuration.",
      detail: 'It has no services or workspaces.',
    });
    return;
  }

  // Custom JavaScript runs inside a signed-in page with everything that page can do. From a file,
  // it is someone else's code in your Gmail unless you wrote it — so it is its own decision, and
  // the default leaves it out.
  const scripted = parsed.services.filter((svc) => typeof svc?.customJs === 'string' && svc.customJs.trim());
  const replaced =
    `This replaces ${loadConfig().services.length} service(s) with ${parsed.services.length} ` +
    'from the file. Existing sessions stay on disk but their services may no longer reference ' +
    'them, so expect to sign in again.';
  const { response } = await dialog.showMessageBox(window as never, {
    type: 'warning',
    buttons: scripted.length
      ? ['Replace, without its scripts', 'Replace, with its scripts', 'Cancel']
      : ['Replace', 'Cancel'],
    defaultId: 0,
    cancelId: scripted.length ? 2 : 1,
    message: 'Replace your current configuration?',
    detail: scripted.length
      ? `${replaced}\n\nIt also adds JavaScript to ${scripted.map((s) => s.name).join(', ')} — code ` +
        'that runs inside those pages, signed in as you. Keep it only if you wrote it.'
      : replaced,
  });
  const keepScripts = scripted.length > 0 && response === 1;
  if (response === (scripted.length ? 2 : 1)) return;

  // Through the SAME normalisation loadConfig uses. This previously did
  // `saveConfig({ ...parsed })` with no defaults, no migration and no version handling, so
  // importing a v3-era export wrote a structurally invalid config straight to disk: missing
  // `preferences` threw in sessionFor, workspaces without `items` threw in flattenServiceIds, and
  // missing `accounts` threw in partitionFor on every service open *and* inside the 60-second
  // persistAll loop, killing it. All under a floating `void importConfig(...)`.
  let normalised: Config;
  try {
    normalised = migrateConfig(parsed);
  } catch (err) {
    await dialog.showMessageBox(window as never, {
      type: 'error',
      message: "That configuration can't be imported.",
      detail: String(err instanceof Error ? err.message : err),
    });
    return;
  }

  if (!keepScripts) {
    normalised = {
      ...normalised,
      services: normalised.services.map(({ customJs: _script, ...svc }) => svc),
    };
  }

  // Keep the current window bounds: they describe this machine's display, not the config.
  saveConfig({ ...normalised, window: loadConfig().window });
  onLoaded();
  console.log(`[transfer] imported from ${file}`);
}

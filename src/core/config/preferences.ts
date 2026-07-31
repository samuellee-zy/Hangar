import type { Preferences } from '@shared/types';

/**
 * Every configurable choice, with defaults.
 *
 * Two rules keep this from becoming a source of crashes:
 *
 *  1. **Defaults are the schema.** A stored config is merged onto these, so a key added in a later
 *     version can never be missing at runtime and older builds ignore keys they don't know.
 *  2. **`setPreference` validates against the defaults** rather than trusting the renderer. A path
 *     that doesn't exist, or a value of the wrong type, is rejected — the IPC boundary is not a
 *     place to assume good input.
 */

export const DEFAULT_PREFERENCES: Preferences = {
  appearance: {
    railPosition: 'left',
    railSize: 72,
    compactRail: false,
    theme: 'system',
    density: 'comfortable',
    gutter: 6,
    showLabels: false,
    showTrayIcon: false,
  },
  behaviour: {
    globalShortcut: null,
    hibernateAfterMinutes: 0, // 0 = never; hibernation lands in phase 4
    launchAtLogin: false,
    startHidden: false,
    closeToTray: false,
    confirmQuit: false,
    defaultZoom: 1,
    spellcheckLanguages: ['en-US'],
  },
  notifications: {
    enabled: true,
    sound: true,
    dnd: false,
    dndUntil: null,
    push: false,
    firebase: { projectId: '', appId: '', apiKey: '', messagingSenderId: '' },
  },
  network: { proxy: { mode: 'system', host: '', port: 0 } },
  sync: { repoPath: '' },
  downloads: { folder: null, askWhereToSave: false, openOnComplete: false },
};

type Json = Record<string, unknown>;

const isPlainObject = (v: unknown): v is Json =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Stored values win, but only for keys the defaults actually define.
 *
 * Always returns a **fresh** object, never `DEFAULT_PREFERENCES` itself. Returning the shared
 * constant for an empty/corrupt input meant the first `setPreference` call mutated the defaults
 * for the rest of the process, so every later merge inherited someone else's setting.
 */
function merge<T>(defaults: T, stored: unknown): T {
  if (!isPlainObject(defaults)) return defaults;
  const out: Json = {};
  for (const [key, fallback] of Object.entries(defaults)) {
    const value = isPlainObject(stored) ? stored[key] : undefined;
    if (isPlainObject(fallback)) {
      out[key] = merge(fallback, value);
    } else if (value === undefined) {
      // Arrays are copied too, or a default like ['en-US'] would be shared and mutable.
      out[key] = Array.isArray(fallback) ? [...fallback] : fallback;
    } else {
      // Copied on the way IN as well, not just when falling back to a default.
      //
      // The Phase 2 fix covered the default path only, which left a second way to alias the same
      // array: pass `DEFAULT_PREFERENCES.behaviour` *as* the stored value — exactly what
      // `resetPreferences` does — and the result shares `spellcheckLanguages` with the constant.
      // The first push to it then mutates the defaults for the rest of the process.
      out[key] = Array.isArray(value) ? [...value] : value;
    }
  }
  return out as T;
}

export const withDefaults = (stored: unknown): Preferences =>
  merge(DEFAULT_PREFERENCES, stored);

/**
 * Applies `appearance.theme = 'dark'` style paths. Returns false when the path is unknown or the
 * value's type doesn't match the default, so a bad command is a no-op rather than a corrupt config.
 */
export function setPreference(prefs: Preferences, path: string, value: unknown): boolean {
  const segments = path.split('.');
  const leaf = segments.pop();
  if (!leaf) return false;

  let target: Json = prefs as unknown as Json;
  let schema: Json = DEFAULT_PREFERENCES as unknown as Json;

  for (const segment of segments) {
    const nextSchema = schema[segment];
    if (!isPlainObject(nextSchema)) return false;
    schema = nextSchema;
    target = target[segment] as Json;
  }

  const fallback = schema[leaf];
  if (fallback === undefined) return false;

  // Only leaves are settable. Allowing a branch would let one command swap out a whole section
  // wholesale — `set-preference appearance {railSize:'huge'}` — skipping every per-key type check
  // below, since object-vs-object passes a naive typeof comparison.
  if (isPlainObject(fallback)) return false;

  // `null` is only allowed where the default is already nullable (dndUntil, downloads.folder).
  if (value === null) {
    if (fallback !== null) return false;
  } else if (fallback !== null) {
    if (Array.isArray(fallback) !== Array.isArray(value)) return false;
    if (!Array.isArray(fallback) && typeof fallback !== typeof value) return false;
  }

  target[leaf] = value;
  return true;
}

/**
 * Restores defaults, for one section or all of them.
 *
 * An unknown section returns the preferences unchanged rather than throwing or resetting
 * everything — this arrives over IPC, and "reset the wrong thing" is a worse failure than
 * "reset nothing".
 */
export function resetPreferences(current: Preferences, section?: string): Preferences {
  if (!section) return withDefaults(undefined);
  if (!(section in DEFAULT_PREFERENCES)) return current;
  const key = section as keyof Preferences;
  // Through `merge` rather than a raw spread, so the result is a fresh object and can't alias
  // DEFAULT_PREFERENCES — the bug that once let one install's setting leak process-wide.
  return withDefaults({ ...current, [key]: DEFAULT_PREFERENCES[key] });
}

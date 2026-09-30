import { DEFAULT_BINDINGS } from '@core/keyboard/keymap';
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
    paneHeaders: false,
  },
  behaviour: {
    globalShortcut: null,
    // 0 = never. Deliberately off: the memory saving is real, but so is the cost of a cold load.
    hibernateAfterMinutes: 0,
    launchAtLogin: false,
    relaunchOnCrash: false,
    closeToTray: false,
    // Off: twenty services all running is twenty pages' memory, which is a choice to make.
    keepAllRunning: false,
    // Off by default: a link that used to open in the browser suddenly opening in a pane would be
    // a surprise, however useful.
    routeLinks: false,
    mailtoServiceId: '',
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
  // Every action, including the ones with no default chord — the schema has to list them or
  // `merge` would drop a stored binding for an action it can't see a default for.
  keyboard: { bindings: { ...DEFAULT_BINDINGS } },
  network: { proxy: { mode: 'system', host: '', port: 0 }, blockAds: true },
  sync: { repoPath: '', allowPublicRepo: false },
  // `notify` on: a file saved without a word looked like a click that did nothing.
  downloads: { folder: null, askWhereToSave: false, openOnComplete: false, notify: true },
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

export const withDefaults = (stored: unknown): Preferences => {
  const merged = merge(DEFAULT_PREFERENCES, stored);
  const keyboard = isPlainObject(stored) ? stored['keyboard'] : undefined;
  const bindings = isPlainObject(keyboard) ? keyboard['bindings'] : undefined;
  if (isPlainObject(bindings)) merged.keyboard.bindings = yieldToStored(merged.keyboard.bindings, bindings);
  return merged;
};

/**
 * An action added since these bindings were stored takes its default chord only if nobody has it.
 *
 * `merge` fills in every action the stored map doesn't list, at its default — right for an action
 * that is new. But a chord you bound to something yourself may be that new action's default, and
 * the first action in `KEY_ACTIONS` order wins a shared chord: an upgrade that added ⇧⌘U quietly
 * took it from the `sleep-others` you'd put there. The new action starts unbound instead.
 */
function yieldToStored(merged: Record<string, string>, stored: Json): Record<string, string> {
  const taken = new Set(Object.values(stored).filter((chord): chord is string => typeof chord === 'string' && chord !== ''));
  const out = { ...merged };
  for (const [actionId, chord] of Object.entries(out)) {
    if (stored[actionId] === undefined && chord && taken.has(chord)) out[actionId] = '';
  }
  return out;
}

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

    // Both sides, not just the schema. The schema half proves the *path* is real; this proves the
    // config actually has an object there to descend into. `withDefaults` rebuilds any branch that
    // isn't one, so today they always agree — but the whole point of this function is that it is
    // the validator standing between an IPC message and the config, and a validator that assumes
    // its input is already well-formed is not one. Without it a `network` holding a string threw a
    // TypeError out of the IPC handler instead of returning false.
    const nextTarget = target[segment];
    if (!isPlainObject(nextTarget)) return false;
    target = nextTarget;
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
/**
 * Preserved by a *full* reset, because they aren't settings — they're values fetched from
 * somewhere else and re-entering them means going back to a console or a filesystem.
 *
 * "Reset all" wiping `sync.repoPath` silently disabled sync under a hint promising only preferences
 * were affected; wiping the Firebase block meant a trip to the Firebase console to retype four
 * fields. Both remain reachable through their own section reset, which is explicit.
 */
const PRESERVED_ON_FULL_RESET = ['sync', 'notifications.firebase'] as const;

export function resetPreferences(current: Preferences, section?: string): Preferences {
  if (!section) {
    const next = withDefaults(undefined) as unknown as Record<string, unknown>;
    const from = current as unknown as Record<string, unknown>;
    for (const path of PRESERVED_ON_FULL_RESET) {
      const [head, leaf] = path.split('.') as [string, string | undefined];
      if (!leaf) next[head] = structuredClone(from[head]);
      else {
        const branch = next[head] as Record<string, unknown>;
        branch[leaf] = structuredClone((from[head] as Record<string, unknown>)[leaf]);
      }
    }
    return next as unknown as Preferences;
  }
  if (!(section in DEFAULT_PREFERENCES)) return current;
  const key = section as keyof Preferences;
  // Through `merge` rather than a raw spread, so the result is a fresh object and can't alias
  // DEFAULT_PREFERENCES — the bug that once let one install's setting leak process-wide.
  return withDefaults({ ...current, [key]: DEFAULT_PREFERENCES[key] });
}

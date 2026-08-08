import fs from 'node:fs';
import path from 'node:path';

/**
 * Durable read and write for `config.json`.
 *
 * Pure with respect to Electron — it takes explicit paths — so the recovery behaviour can be tested
 * directly. That matters, because the failure this exists to prevent is unrecoverable.
 *
 * **The bug this replaces.** `saveConfig` was a plain `writeFileSync` and `loadConfig` responded to
 * a parse failure by writing defaults straight over the file. So: crash mid-write → truncated JSON
 * → next launch destroys every service, account, folder and preference, and orphans every partition
 * on disk. Config is written on every preference change, every layout change and a 400ms
 * window-bounds debounce, so the window for a bad write was not small.
 *
 * Three guarantees now:
 *   1. **Atomic writes.** Temp file plus rename, which is atomic within a filesystem. A reader sees
 *      either the whole old file or the whole new one, never half of either.
 *   2. **A corrupt file is never overwritten.** It's moved aside for inspection.
 *   3. **A rolling backup**, so recovery doesn't depend on the user having exported.
 */

export interface ConfigPaths {
  /** `.../config.json` */
  main: string;
  /** `.../config.backup.json` — the previous good copy. */
  backup: string;
}

export const pathsFor = (dir: string): ConfigPaths => ({
  main: path.join(dir, 'config.json'),
  backup: path.join(dir, 'config.backup.json'),
});

/**
 * `Date.now()` is millisecond-resolution, so two failures in the same tick would collide and the
 * second rename would silently destroy the first bad copy — the exact thing quarantine exists to
 * prevent. Suffix until free.
 */
function uniquePath(candidate: string): string {
  if (!fs.existsSync(candidate)) return candidate;
  for (let n = 2; ; n++) {
    const next = `${candidate}-${n}`;
    if (!fs.existsSync(next)) return next;
  }
}

export interface ReadResult<T> {
  value: T | null;
  /** Populated when something unusual happened, for logging. */
  note?: string;
  /** Where a quarantined file was moved, if any. */
  quarantined?: string;
}

/**
 * Reads the main file; on failure quarantines it and falls back to the backup.
 *
 * `parse` is passed in rather than assumed to be `JSON.parse` so the caller can also reject
 * structurally-invalid-but-parseable content — an empty object is valid JSON and useless as config.
 */
export function readWithRecovery<T>(
  paths: ConfigPaths,
  parse: (raw: string) => T
): ReadResult<T> {
  const attempt = (file: string): T | null => {
    try {
      return parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return null;
    }
  };

  const primary = attempt(paths.main);
  if (primary) return { value: primary };

  // Nothing there at all is the normal first-run case, not a corruption.
  if (!fs.existsSync(paths.main)) {
    const fromBackup = attempt(paths.backup);
    return fromBackup
      ? { value: fromBackup, note: 'config.json was missing; restored from backup' }
      : { value: null };
  }

  // Present but unreadable. Preserve it — this is the only copy of the user's setup.
  const quarantined = uniquePath(`${paths.main}.corrupt-${Date.now()}`);
  try {
    fs.renameSync(paths.main, quarantined);
  } catch {
    // If even the rename fails, refuse to continue destructively: return null and let the caller
    // start from defaults *without* writing over anything.
    return { value: null, note: 'config.json is unreadable and could not be quarantined' };
  }

  const fromBackup = attempt(paths.backup);
  return {
    value: fromBackup,
    quarantined,
    note: fromBackup
      ? `config.json was corrupt; recovered from backup. Bad copy kept at ${quarantined}`
      : `config.json was corrupt and no backup existed. Bad copy kept at ${quarantined}`,
  };
}

/**
 * Moves a readable-but-unusable config aside, using the same naming `readWithRecovery` uses so it
 * shows up in `findQuarantined` and therefore at boot and in Settings.
 *
 * Separate from the read path because the two failures are different: that one can't parse the
 * file, this one parsed it fine and then found it self-inconsistent — a service naming an account
 * that doesn't exist, say. Both leave the user on defaults, and in both cases the copy they care
 * about must survive and be findable.
 *
 * Returns where it went, or null if it couldn't be moved. Never throws: this runs on the failure
 * path, and failing there must not stop the app booting on defaults.
 */
export function quarantine(paths: ConfigPaths): string | null {
  if (!fs.existsSync(paths.main)) return null;
  const target = uniquePath(`${paths.main}.corrupt-${Date.now()}`);
  try {
    fs.renameSync(paths.main, target);
    return target;
  } catch {
    return null;
  }
}

/**
 * Quarantined copies left behind by earlier failures, newest first.
 *
 * These are the only surviving record of a config that couldn't be read, and until now nothing ever
 * mentioned them again — a user whose setup was replaced by defaults had a full copy sitting beside
 * it and no way to know. Surfaced at boot and in Settings.
 *
 * Never deleted automatically. A file that exists because recovery failed is the last thing that
 * should be cleaned up by the same code that failed.
 */
export function findQuarantined(paths: ConfigPaths): string[] {
  const dir = path.dirname(paths.main);
  const prefix = `${path.basename(paths.main)}.corrupt-`;
  try {
    return fs
      .readdirSync(dir)
      .filter((name) => name.startsWith(prefix))
      .map((name) => path.join(dir, name))
      // Newest first. The suffix is a millisecond timestamp, so a lexical sort would put
      // `...-2` (the collision suffix) in the wrong place; sort by mtime instead.
      .sort((a, b) => statMs(b) - statMs(a));
  } catch {
    return [];
  }
}

function statMs(file: string): number {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * Writes atomically, rotating the previous good copy into the backup first.
 *
 * The temp file sits in the same directory deliberately: `rename` is only atomic within a
 * filesystem, and a temp dir can easily be on another volume.
 */
export function writeAtomic(paths: ConfigPaths, contents: string): void {
  const dir = path.dirname(paths.main);
  fs.mkdirSync(dir, { recursive: true });

  // Rotate before overwriting, so the backup is always the last known-good state.
  if (fs.existsSync(paths.main)) {
    try {
      fs.copyFileSync(paths.main, paths.backup);
    } catch {
      // A failed rotation must not block the write — the current config still matters more.
    }
  }

  const temp = `${paths.main}.tmp`;
  // Write, flush, *then* rename. `rename` is atomic with respect to ordering, but without the
  // fsync the temp file's contents may still be in the page cache — so a power loss can leave a
  // correctly-named file full of zeroes, which is the failure this whole module exists to prevent.
  const fd = fs.openSync(temp, 'w');
  try {
    fs.writeFileSync(fd, contents);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temp, paths.main);
}

import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';

/**
 * The last-synced config snapshot.
 *
 * Deliberately a sidecar in `userData` rather than a field on `Config`: anything inside `Config` is
 * a candidate for syncing, and a base that synced itself would be worthless.
 *
 * Loss is survivable by design — `decideSync` treats a missing base as "cannot tell who is ahead"
 * and refuses rather than guessing, so there is no atomic-write machinery here. It's a cache, not
 * a record.
 */

const file = () => path.join(app.getPath('userData'), 'sync-base.json');

export function readSyncBase(): string | null {
  try {
    return fs.readFileSync(file(), 'utf8');
  } catch {
    return null;
  }
}

export function writeSyncBase(serialised: string): void {
  try {
    fs.writeFileSync(file(), serialised);
  } catch (err) {
    // Worth saying: without a base the next reconcile reports a conflict rather than syncing.
    console.warn('[sync] could not record the sync base:', err);
  }
}

import { Text, Toggle } from '../PreferenceControls';
import type { Preferences, SyncStatus } from '@shared/types';
import { ConfirmButton } from '../ConfirmButton';

/**
 * Turns the sync state into something worth reading. An opaque "error" helps nobody.
 *
 * Exported and pure so the conflict wording can be asserted without rendering the whole window.
 */
export function syncNote(status: SyncStatus): string {
  switch (status.state) {
    case 'off':
      return 'Empty disables sync';
    case 'unavailable':
      return status.reason;
    case 'conflict':
      // Deliberately not auto-merged: guessing which machine's rename to keep can cost an
      // account-to-partition mapping, which signs you out of something you never touched.
      return `Diverged — resolve in the repo, then Sync. ${status.detail}`;
    case 'error':
      return status.detail;
    case 'idle':
      return status.lastSync
        ? `Last synced ${new Date(status.lastSync).toLocaleTimeString()}`
        : 'Ready';
  }
}

export function Sync({
  sync,
  status,
}: {
  sync: Preferences['sync'];
  status: SyncStatus;
}) {
  return (
    <section>
      <h2>Sync</h2>
      <p className="hint">
        Keeps your services, accounts and preferences in step across machines through a git repo
        you control. Point this at a local clone; Hangar pulls on launch and commits when
        something changes.
        {' '}
        <b>Sessions do not sync</b> — cookie jars stay on the machine that created them, so a
        second machine gets your setup and asks you to sign in. Window size and pane layouts stay
        local too, because they're shaped to a particular screen.
      </p>
      <ul className="rows">
        <Text
          name="Repository path"
          note={syncNote(status)}
          path="sync.repoPath"
          value={sync.repoPath}
          placeholder="~/code/dotfiles"
        />
        <Toggle
          name="Allow a public repository"
          note="Off by default. Hangar refuses to sync into a repo that answers an anonymous request, because the file lists your services, account labels and any custom URLs — no credentials, but not for strangers."
          path="sync.allowPublicRepo"
          value={sync.allowPublicRepo}
        />
        <li className="pref">
          <span className="pref-label">
            <span className="pref-name">Sync now</span>
            <span className="pref-note">Fetch, then push or pull depending on which side moved</span>
          </span>
          <button
            disabled={!sync.repoPath.trim()}
            onClick={() => window.hangar.send({ type: 'sync-now' })}
          >
            Sync
          </button>
        </li>
      </ul>

      {status.state === 'conflict' && <ConflictResolution />}
    </section>
  );
}

/**
 * Only rendered on a conflict.
 *
 * Detecting one and offering nothing leaves the user stuck forever, so both directions are explicit
 * and each button names what it throws away — Hangar will not guess which machine's edit to keep,
 * because a wrong guess can cost an account-to-partition mapping and sign you out of something you
 * never touched.
 */
function ConflictResolution() {
  return (
    <>
      <h3>Resolve the conflict</h3>
      <p className="hint">
        This machine and the repo have both changed since they last agreed. Nothing has been
        modified. Pick which copy to keep — <b>the other one is discarded.</b>
      </p>
      <ul className="rows">
        <li className="pref">
          <span className="pref-label">
            <span className="pref-name">Keep this machine's</span>
            <span className="pref-note">Overwrites the repo. Discards what the other machine changed.</span>
          </span>
          <ConfirmButton
            confirmLabel="Overwrite the repo?"
            onConfirm={() => window.hangar.send({ type: 'resolve-sync', winner: 'local' })}
          >
            Keep local
          </ConfirmButton>
        </li>
        <li className="pref">
          <span className="pref-label">
            <span className="pref-name">Keep the repo's</span>
            <span className="pref-note">Overwrites this machine. Discards changes made here since the last sync.</span>
          </span>
          <ConfirmButton
            confirmLabel="Overwrite this machine?"
            onConfirm={() => window.hangar.send({ type: 'resolve-sync', winner: 'remote' })}
          >
            Keep repo
          </ConfirmButton>
        </li>
      </ul>
    </>
  );
}

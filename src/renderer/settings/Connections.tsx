import { CommitOnBlur } from '../CommitOnBlur';
import { ConfirmButton } from '../ConfirmButton';
import type { ShellState } from '@shared/types';

/**
 * Workspaces, folders and accounts: the sections that list what you've arranged, rather than
 * preference rows. Services themselves are in `ServiceSettings.tsx`.
 */

export function Workspaces({ state }: { state: ShellState }) {
  return (
    <section>
      <h2>Workspaces</h2>
      <p className="hint">
        Each workspace has its own rail contents and remembers its own pane layout. Deleting one
        keeps its services — anything not in another workspace moves to the first.
      </p>
      <ul className="rows">
        {state.workspaces.map((ws) => (
          <li key={ws.id}>
            <CommitOnBlur
              aria-label={`Workspace name, ${ws.name}`}
              value={ws.name}
              onCommit={(name) =>
                window.hangar.send({ type: 'rename-workspace', workspaceId: ws.id, name })
              }
            />
            <span className="meta">
              {ws.id === state.activeWorkspaceId ? 'active · ' : ''}
              {ws.items.length} item{ws.items.length === 1 ? '' : 's'}
            </span>
            <ConfirmButton
              disabled={state.workspaces.length <= 1}
              title={
                state.workspaces.length <= 1
                  ? 'The last workspace cannot be deleted'
                  : `Delete ${ws.name}`
              }
              confirmLabel={`Delete ${ws.name}?`}
              onConfirm={() => window.hangar.send({ type: 'delete-workspace', workspaceId: ws.id })}
            >
              Delete
            </ConfirmButton>
          </li>
        ))}
        <li className="pref">
          <span className="pref-label">
            <span className="pref-name">New workspace</span>
            <span className="pref-note">Switch with ⌘⌥1…9</span>
          </span>
          <button
            className="secondary"
            onClick={() => window.hangar.send({ type: 'create-workspace', name: 'Workspace' })}
          >
            Add
          </button>
        </li>
      </ul>
    </section>
  );
}

/**
 * Every folder in every workspace, renamable.
 *
 * The rail can only edit a name in place when it is an opened panel; an ordinary or horizontal rail
 * has nowhere to put a text field, so right-click ▸ Rename… comes here. Before this section existed
 * it came here too, to a page with no folders on it — every folder stayed "New folder" for good.
 */
export function Folders({ state }: { state: ShellState }) {
  const folders = state.workspaces.flatMap((ws) =>
    ws.items.flatMap((item) => (item.kind === 'folder' ? [{ ws, folder: item }] : [])),
  );
  const multipleWorkspaces = state.workspaces.length > 1;

  return (
    <section>
      <h2>Folders</h2>
      <p className="hint">
        Make one from a tile's right-click menu. Ungrouping keeps the services.
      </p>
      {/* Shown with no folders too: the section used to vanish, and with it the one line saying how
          to make a folder — at exactly the moment someone was looking for it. */}
      <ul className="rows">
        {folders.length === 0 && <li className="empty">No folders yet.</li>}
        {folders.map(({ ws, folder }) => (
          <li key={folder.id}>
            <CommitOnBlur
              aria-label={`Folder name, ${folder.name}`}
              value={folder.name}
              onCommit={(name) =>
                window.hangar.send({ type: 'rename-folder', folderId: folder.id, name })
              }
            />
            <span className="meta">
              {multipleWorkspaces ? `${ws.name} · ` : ''}
              {folder.serviceIds.length} service{folder.serviceIds.length === 1 ? '' : 's'}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function Accounts({ state }: { state: ShellState }) {
  return (
    <section>
      <h2>Accounts</h2>
      <p className="hint">
        An account is one cookie jar. Services sharing an account share a login — signing out
        affects all of them.
      </p>
      <ul className="rows">
        {state.accounts.map((account) => {
          const users = state.allServices.filter((s) => s.accountId === account.id);
          return (
            <li key={account.id}>
              <CommitOnBlur
                aria-label={`Account name, ${account.label}`}
                value={account.label}
                onCommit={(label) =>
                  window.hangar.send({ type: 'rename-account', accountId: account.id, label })
                }
              />
              <span className="meta">
                {users.length ? users.map((s) => s.name).join(', ') : 'unused'}
              </span>
              {/* Per account because blocking is per session. Settings → Network used to be the
                  only switch, so a service that broke under it had it turned off everywhere. */}
              <select
                aria-label={`Ad blocking for ${account.label}`}
                value={account.blockAds === undefined ? 'default' : account.blockAds ? 'on' : 'off'}
                onChange={(e) =>
                  window.hangar.send({
                    type: 'set-account-adblock',
                    accountId: account.id,
                    on: e.target.value === 'default' ? null : e.target.value === 'on',
                  })
                }
              >
                <option value="default">Ads: as in Network</option>
                <option value="on">Ads: blocked</option>
                <option value="off">Ads: allowed</option>
              </select>
              <button
                className="secondary"
                title="Clears cached files and service workers — not cookies, so it stays signed in"
                onClick={() => window.hangar.send({ type: 'clear-account-cache', accountId: account.id })}
              >
                Clear cache
              </button>
              <ConfirmButton
                title={`Clear cookies for ${account.label}`}
                confirmLabel={users.length > 1 ? `Sign out of all ${users.length}?` : 'Sign out?'}
                onConfirm={() =>
                  window.hangar.send({ type: 'sign-out-account', accountId: account.id })
                }
              >
                Sign out
              </ConfirmButton>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

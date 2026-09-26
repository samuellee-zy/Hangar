import { catalogById } from '@shared/catalog';
import { CommitOnBlur } from '../CommitOnBlur';
import { ConfirmButton } from '../ConfirmButton';
import type { ShellState } from '@shared/types';

/**
 * The sections that list what you've actually connected, rather than preference rows.
 *
 * All four read `allServices`, not `services` — removing or renaming should reach a service that
 * lives in a workspace you aren't currently looking at.
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
  if (folders.length === 0) return null;
  const multipleWorkspaces = state.workspaces.length > 1;

  return (
    <section>
      <h2>Folders</h2>
      <p className="hint">
        Make one from a tile's right-click menu. Ungrouping keeps the services.
      </p>
      <ul className="rows">
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

export function Connections({ state }: { state: ShellState }) {
  const labelFor = (accountId: string) =>
    state.accounts.find((a) => a.id === accountId)?.label ?? 'unknown';

  return (
    <section>
      <h2>Connections</h2>
      <p className="hint">
        Reorder by dragging tiles in the rail. Removing a connection leaves its account signed in.
      </p>
      <ul className="rows">
        {state.allServices.map((svc) => (
          <li key={svc.id}>
            <CommitOnBlur
              value={svc.name}
              onCommit={(name) =>
                window.hangar.send({ type: 'rename-service', serviceId: svc.id, name })
              }
            />
            <span className="meta">{labelFor(svc.accountId)}</span>
            <ConfirmButton
              title={`Remove ${svc.name}`}
              confirmLabel={`Remove ${svc.name}?`}
              onConfirm={() => window.hangar.send({ type: 'remove-service', serviceId: svc.id })}
            >
              Remove
            </ConfirmButton>
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
                value={account.label}
                onCommit={(label) =>
                  window.hangar.send({ type: 'rename-account', accountId: account.id, label })
                }
              />
              <span className="meta">
                {users.length ? users.map((s) => s.name).join(', ') : 'unused'}
              </span>
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

/** Splits what was typed into hosts. Main validates each one; this only has to find them. */
export const parseHosts = (text: string): string[] =>
  [...new Set(text.split(/[\s,]+/).map((h) => h.trim().toLowerCase()).filter(Boolean))];

/**
 * Where each service may navigate without being sent to the browser, and a field to add more.
 *
 * It only *listed* the hosts, while this hint and the Add Connection form both told you to add a
 * sign-in provider's domain here. The only way to add one was the Allow button on the blocked page,
 * which needs the block to happen first. Every service is listed, not just custom ones: a catalog
 * service behind a company SSO needs that SSO's domain just as much.
 *
 * What you type is additive — `extraAllowedHosts` — and never replaces the catalog's own list, for
 * the reason on that field. Main keeps only valid hostnames, so the field showing back what was
 * accepted is the feedback when something wasn't.
 */
export function CustomHosts({ state }: { state: ShellState }) {
  const custom = state.allServices.filter((s) => s.allowedHosts);

  return (
    <section>
      <h2>Allowed hosts</h2>
      <p className="hint">
        A service only stays in-app on these domains; anything else opens in your browser. If it
        signs in with Google, Okta or your company's SSO, add that domain — separate several with
        commas.
      </p>
      <ul className="rows">
        {custom.length === 0 && <li className="empty">No custom connections yet.</li>}
        {state.allServices.map((svc) => {
          const base = svc.allowedHosts ?? catalogById(svc.catalogId)?.allowedHosts ?? [];
          const shown = base.slice(0, 3).join(', ') + (base.length > 3 ? ` +${base.length - 3}` : '');
          return (
            <li key={svc.id}>
              <span className="meta grow" title={base.join(', ')}>
                {svc.name}
                {shown && <span className="hosts-base"> — {shown}</span>}
              </span>
              <CommitOnBlur
                aria-label={`Extra allowed hosts for ${svc.name}`}
                placeholder="login.example.com"
                allowEmpty
                value={(svc.extraAllowedHosts ?? []).join(', ')}
                onCommit={(text) =>
                  window.hangar.send({
                    type: 'update-service',
                    serviceId: svc.id,
                    patch: { extraAllowedHosts: parseHosts(text) },
                  })
                }
              />
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export function PerService({ state }: { state: ShellState }) {
  return (
    <section>
      <h2>Per-service</h2>
      <p className="hint">
        Zoom applies immediately. Custom CSS, JS and user agent need a reload of that service.
      </p>
      <ul className="rows">
        {state.allServices.map((svc) => (
          <li key={svc.id} className="pref">
            <span className="pref-label">
              <span className="pref-name">{svc.name}</span>
              <span className="pref-note">
                {svc.customCss ? 'custom CSS · ' : ''}
                {svc.customJs ? 'custom JS · ' : ''}
                {svc.notificationLevel === 'muted' ? 'muted · ' : ''}
                {svc.hibernate ? 'may hibernate' : 'never hibernates'}
              </span>
            </span>
            <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              {!catalogById(svc.catalogId) && (
                <label
                  className="pref-note"
                  style={{ display: 'flex', gap: 4 }}
                  title="Custom connections are denied the microphone and camera unless allowed here"
                >
                  <input
                    type="checkbox"
                    checked={Boolean(svc.allowMedia)}
                    onChange={(e) =>
                      window.hangar.send({
                        type: 'update-service',
                        serviceId: svc.id,
                        patch: { allowMedia: e.target.checked },
                      })
                    }
                  />
                  mic/camera
                </label>
              )}
              <label className="pref-note" style={{ display: 'flex', gap: 4 }}>
                <input
                  type="checkbox"
                  checked={svc.hibernate}
                  onChange={(e) =>
                    window.hangar.send({
                      type: 'update-service',
                      serviceId: svc.id,
                      patch: { hibernate: e.target.checked },
                    })
                  }
                />
                hibernate
              </label>
              {/* Muting is per service and stops the badge as well as the banner — the count is
                  pushed back to the page as an empty rule set, so a muted service stops watching
                  for a number it is not allowed to report. */}
              <label
                className="pref-note"
                style={{ display: 'flex', gap: 4 }}
                title="Silence this service's notifications and unread badge"
              >
                <input
                  type="checkbox"
                  checked={svc.notificationLevel === 'muted'}
                  onChange={(e) =>
                    window.hangar.send({
                      type: 'update-service',
                      serviceId: svc.id,
                      patch: { notificationLevel: e.target.checked ? 'muted' : 'all' },
                    })
                  }
                />
                mute
              </label>
              {/* Same reason as the proxy port: on change, every digit of "1.25" was its own config
                  write and sync reschedule, and the zoom jumped through each partial value on the
                  way. */}
              <CommitOnBlur
                className="field"
                type="number"
                min={0.5}
                max={2}
                step={0.1}
                style={{ width: 66 }}
                title="Zoom"
                value={String(svc.zoom)}
                onCommit={(next) => {
                  const zoom = Number(next);
                  if (!Number.isFinite(zoom)) return;
                  window.hangar.send({
                    type: 'update-service',
                    serviceId: svc.id,
                    patch: { zoom: Math.min(2, Math.max(0.5, zoom)) },
                  });
                }}
              />
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

import { catalogById } from '@shared/catalog';
import { chordFor } from './chords';
import { ServiceIcon } from './ServiceIcon';
import { useShellState } from './useShellState';

/**
 * Shown in place of the panes when there is nothing to display — no services at all, or every
 * service asleep with none loaded.
 *
 * Without this, removing the last connection left a blank window whose only exit was a `+` in a
 * rail that also looked empty. The app read as broken rather than empty.
 *
 * Three states, not two. Before the first state arrives it says nothing — it used to say "No
 * connections yet" to people with a dozen, for the moment it took to load. A first run gets a
 * handful of one-click starters rather than a single button into a catalog of seventy. And with
 * services but nothing open, it lists them: "pick a service from the rail" was an instruction to go
 * and do what this screen could have done.
 */

/** The first-run grid. Common enough that most people will want at least one. */
const STARTERS = ['gmail', 'gcal', 'slack', 'notion', 'outlook', 'teams', 'whatsapp', 'chatgpt'];

export function EmptyState() {
  const state = useShellState();
  if (!state) return <div className="empty-state" aria-busy="true" />;

  const add = chordFor(state, 'add-connection');
  const palette = chordFor(state, 'palette');
  const settings = chordFor(state, 'settings');
  const hints = [
    add && `${add} to add`,
    palette && `${palette} to jump`,
    settings && `${settings} for settings`,
  ].filter(Boolean);

  if (state.allServices.length === 0) {
    const starters = STARTERS.map((id) => catalogById(id)).filter(
      (entry): entry is NonNullable<typeof entry> => Boolean(entry),
    );
    return (
      <div className="empty-state">
        <h1>Welcome to Hangar</h1>
        <p>
          Each connection gets its own isolated session. Services from one provider share a login —
          Gmail and Calendar, say — and a second Gmail is simply a second account.
        </p>
        <ul className="starter-grid" aria-label="Add a connection">
          {starters.map((entry) => (
            <li key={entry.id}>
              <button onClick={() => window.hangar.send({ type: 'add-service', catalogId: entry.id })}>
                {entry.icon ? (
                  <img className="starter-icon" src={`hangar-catalog://${entry.icon}`} alt="" />
                ) : (
                  <span className="starter-icon starter-initials">{entry.initials}</span>
                )}
                <span>{entry.name}</span>
              </button>
            </li>
          ))}
        </ul>
        <button onClick={() => window.hangar.send({ type: 'open-connections' })}>
          Browse all, or add any website by URL
        </button>
        {hints.length > 0 && <span className="empty-hint">{hints.join(' · ')}</span>}
      </div>
    );
  }

  const here = state.services.slice(0, 12);
  return (
    <div className="empty-state">
      <h1>Nothing open</h1>
      <p>{here.length ? 'Open one of these, or add another.' : 'This workspace is empty.'}</p>
      {here.length > 0 && (
        <ul className="wake-list" aria-label="Services in this workspace">
          {here.map((svc) => (
            <li key={svc.id}>
              <button onClick={() => window.hangar.send({ type: 'focus-service', serviceId: svc.id })}>
                <ServiceIcon serviceId={svc.id} initials={svc.initials} name={svc.name} />
                <span className="wake-name">{svc.name}</span>
                {svc.unread > 0 && <span className="wake-unread">{svc.unread}</span>}
                <span className="wake-state">{svc.sleeping ? 'asleep' : 'open'}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <button onClick={() => window.hangar.send({ type: 'open-connections' })}>Add a connection</button>
      {hints.length > 0 && <span className="empty-hint">{hints.join(' · ')}</span>}
    </div>
  );
}

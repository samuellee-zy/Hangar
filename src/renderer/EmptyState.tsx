import { useShellState } from './useShellState';

/**
 * Shown in place of the panes when there is nothing to display — no services at all, or every
 * service asleep with none loaded.
 *
 * Without this, removing the last connection left a blank window whose only exit was a `+` in a
 * rail that also looked empty. The app read as broken rather than empty.
 */
export function EmptyState() {
  const state = useShellState();
  const hasServices = (state?.allServices.length ?? 0) > 0;

  return (
    <div className="empty-state">
      <h1>{hasServices ? 'Nothing open' : 'No connections yet'}</h1>
      <p>
        {hasServices
          ? 'Pick a service from the rail, or add another.'
          : 'Add Gmail, Slack, Notion — or any website by URL. Each gets its own isolated session.'}
      </p>
      <button onClick={() => window.hangar.send({ type: 'open-connections' })}>
        Add a connection
      </button>
      <span className="empty-hint">⌘N to add · ⌘K to jump · ⌘, for settings</span>
    </div>
  );
}
